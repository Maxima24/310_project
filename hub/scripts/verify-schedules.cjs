/**
 * End-to-end check of scheduled arming against the running hub and a real Postgres.
 *
 * The evaluator is driven directly with an injected `now`, because the interesting
 * claims are all about time — fires once, holds during an incident, refuses a stale
 * boundary — and waiting for a real clock to reach them would take a day. The CRUD and
 * permission surface goes over real HTTP.
 *
 * Restores the system mode and deletes everything it creates.
 *
 *   node hub/scripts/verify-schedules.cjs
 */
const { PrismaClient } = require('@prisma/client');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { ScheduleRunnerService } = require('../dist/schedules/schedule-runner.service');
const { PolicyService } = require('../dist/common/security/policy.service');
const { AuditService } = require('../dist/audit/audit.service');

const BASE = process.env.HUB_URL ?? 'http://localhost:3000';
const PROBE_PREFIX = 'verify-probe:';

let passed = 0;
let failed = 0;

function ok(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`ok   ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function loadEnv() {
  const text = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

async function call(method, path, { key, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, body: json };
}

/** Wires the real evaluator against the real database, with a controllable grace. */
function buildRunner(prisma, system, graceMinutes = 60) {
  const config = {
    get: (key) => {
      if (key === 'schedules.tickCron') return '*/30 * * * * *';
      if (key === 'schedules.graceMinutes') return graceMinutes;
      return undefined;
    },
  };

  return new ScheduleRunnerService(
    prisma,
    system,
    new PolicyService(prisma),
    new AuditService(prisma),
    config,
    { addCronJob: () => {} },
  );
}

async function main() {
  const env = loadEnv();
  const prisma = new PrismaClient();
  const startedAt = new Date();

  // A stand-in for SystemService that records calls without needing the WebSocket
  // gateway. The unit tests already assert the runner routes through SystemService.
  const modeCalls = [];
  const system = {
    setMode: async (mode) => {
      modeCalls.push(mode);
      const previous = (await prisma.systemState.findUnique({ where: { id: 1 } }))?.mode;
      await prisma.systemState.update({ where: { id: 1 }, data: { mode } });
      return { mode, previous, changed: previous !== mode, updatedAt: new Date().toISOString() };
    },
  };

  let originalMode = 'disarmed';

  try {
    const health = await call('GET', '/health');
    if (health.status !== 200) {
      console.error(`Hub not reachable at ${BASE}. Start it first.`);
      process.exit(1);
    }
    originalMode =
      (await call('GET', '/system/mode', { key: env.OPERATOR_KEY })).body?.mode ?? 'disarmed';

    console.log('--- authoring over HTTP ---');
    const created = await call('POST', '/schedules', {
      key: env.OPERATOR_KEY,
      body: {
        name: `${PROBE_PREFIX}nightly arm`,
        mode: 'away',
        startMinute: 22 * 60,
        timezone: 'America/New_York',
        daysOfWeek: [1, 2, 3, 4, 5],
      },
    });
    ok('an operator can create a schedule', created.status === 201, `status ${created.status}`);
    ok('days come back sorted', JSON.stringify(created.body?.daysOfWeek) === '[1,2,3,4,5]');

    const badZone = await call('POST', '/schedules', {
      key: env.OPERATOR_KEY,
      body: {
        name: `${PROBE_PREFIX}bad`,
        mode: 'away',
        startMinute: 60,
        timezone: 'America/Metropolis',
      },
    });
    ok('an unresolvable zone is refused at write time', badZone.status === 400);

    const viewerWrite = await call('POST', '/schedules', {
      key: env.VIEWER_KEY,
      body: { name: `${PROBE_PREFIX}v`, mode: 'away', startMinute: 60, timezone: 'UTC' },
    });
    ok('a viewer cannot author one', viewerWrite.status === 403, `status ${viewerWrite.status}`);

    const viewerRead = await call('GET', '/schedules', { key: env.VIEWER_KEY });
    ok('a viewer CAN read them', viewerRead.status === 200, `status ${viewerRead.status}`);

    console.log('\n--- a due schedule fires, exactly once ---');
    await prisma.armSchedule.deleteMany({ where: { name: { startsWith: PROBE_PREFIX } } });
    await prisma.systemState.upsert({
      where: { id: 1 },
      update: { mode: 'disarmed' },
      create: { id: 1, mode: 'disarmed' },
    });

    const arm = await prisma.armSchedule.create({
      data: {
        name: `${PROBE_PREFIX}arm`,
        mode: 'away',
        startMinute: 12 * 60,
        timezone: 'UTC',
        daysOfWeek: [],
      },
    });

    const runner = buildRunner(prisma, system);
    const at1210 = new Date('2026-08-14T12:10:00Z');

    const tick1 = await runner.tick(at1210);
    ok('it fired', tick1.fired === 1, JSON.stringify(tick1));
    ok('the mode moved to away', modeCalls[modeCalls.length - 1] === 'away');

    const tick2 = await runner.tick(new Date('2026-08-14T12:20:00Z'));
    ok('a second tick in the same window does nothing', tick2.fired === 0);

    const afterFire = await prisma.armSchedule.findUnique({ where: { id: arm.id } });
    ok('the local date was stamped', afterFire.lastFiredFor === '2026-08-14');
    ok('the fire time was recorded', afterFire.lastFiredAt !== null);

    console.log('\n--- a manual override does not defeat the next boundary ---');
    await prisma.systemState.update({ where: { id: 1 }, data: { mode: 'disarmed' } });
    const before = modeCalls.length;
    // Next day, same schedule.
    await runner.tick(new Date('2026-08-15T12:05:00Z'));
    ok(
      'it fired again the next day despite the manual disarm',
      modeCalls.length === before + 1 && modeCalls[modeCalls.length - 1] === 'away',
    );

    console.log('\n--- a scheduled DISARM is held during an open critical alert ---');
    await prisma.armSchedule.deleteMany({ where: { id: arm.id } });
    const disarm = await prisma.armSchedule.create({
      data: {
        name: `${PROBE_PREFIX}disarm`,
        mode: 'disarmed',
        startMinute: 12 * 60,
        timezone: 'UTC',
        daysOfWeek: [],
      },
    });

    const blocker = await prisma.alert.create({
      data: {
        type: 'intrusion_motion',
        severity: 'critical',
        message: `${PROBE_PREFIX}unacknowledged critical`,
        modeAtTrigger: 'away',
        acknowledged: false,
      },
    });

    const held = await runner.tick(at1210);
    ok('it was held, not fired', held.held === 1 && held.fired === 0, JSON.stringify(held));

    const stillUnclaimed = await prisma.armSchedule.findUnique({ where: { id: disarm.id } });
    ok(
      'a held schedule stays unclaimed so it can still arrive',
      stillUnclaimed.lastFiredFor === null,
    );

    const heldAudit = await prisma.auditLog.findFirst({
      where: { at: { gte: startedAt }, action: 'schedule_fired', outcome: 'denied' },
      orderBy: { at: 'desc' },
    });
    ok('the hold is on the record', Boolean(heldAudit));
    ok('attributed to `system`, not a person', heldAudit?.actor === 'system');
    ok('with the reason', /unacknowledged/i.test(heldAudit?.reason ?? ''));

    console.log('\n--- once acknowledged, the same window still delivers ---');
    await prisma.alert.update({
      where: { id: blocker.id },
      data: { acknowledged: true, acknowledgedAt: new Date() },
    });
    // Other pre-existing critical alerts would block it just as validly.
    const otherOpen = await prisma.alert.count({
      where: { severity: 'critical', acknowledged: false },
    });

    if (otherOpen === 0) {
      const delivered = await runner.tick(new Date('2026-08-14T12:30:00Z'));
      ok('it fired late in the same window', delivered.fired === 1, JSON.stringify(delivered));
    } else {
      console.log(`     skipped: ${otherOpen} other unacknowledged critical alert(s) still hold it`);
    }

    console.log('\n--- a stale boundary is recorded, not acted on ---');
    await prisma.armSchedule.deleteMany({ where: { id: disarm.id } });
    const stale = await prisma.armSchedule.create({
      data: {
        name: `${PROBE_PREFIX}stale`,
        mode: 'away',
        startMinute: 7 * 60,
        timezone: 'UTC',
        daysOfWeek: [],
      },
    });

    const callsBefore = modeCalls.length;
    const missed = await runner.tick(at1210); // 5 hours past a 60-minute grace
    ok('it was recorded as missed', missed.missed === 1, JSON.stringify(missed));
    ok('the mode was NOT changed hours late', modeCalls.length === callsBefore);

    const staleRow = await prisma.armSchedule.findUnique({ where: { id: stale.id } });
    ok('the miss was claimed so it is logged once', staleRow.lastFiredFor === '2026-08-14');
    ok('no fire time was invented for it', staleRow.lastFiredAt === null);

    const missAudit = await prisma.auditLog.findFirst({
      where: { at: { gte: startedAt }, action: 'schedule_fired', targetId: stale.id },
    });
    ok('the miss is on the record', missAudit?.outcome === 'denied');
    ok('with a reason a human can act on', /grace window/i.test(missAudit?.reason ?? ''));

    const repeat = await runner.tick(new Date('2026-08-14T12:40:00Z'));
    ok('it does not re-log the miss every tick', repeat.missed === 0);
  } finally {
    await call('POST', '/system/mode', { key: env.ADMIN_KEY, body: { mode: originalMode } });
    await prisma.armSchedule.deleteMany({ where: { name: { startsWith: PROBE_PREFIX } } });
    await prisma.alert.deleteMany({ where: { message: { startsWith: PROBE_PREFIX } } });
    await prisma.auditLog.deleteMany({ where: { at: { gte: startedAt } } });
    await prisma.$disconnect();
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
