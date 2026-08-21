/**
 * End-to-end check of the retention sweep against a real Postgres.
 *
 * Unit tests mock Prisma, so they prove the service issues the right statements but not
 * that Postgres accepts them — `ON CONFLICT`, `date_trunc`, and `gen_random_uuid()::text`
 * are exactly the kind of thing that type-checks and then fails at runtime. This runs the
 * real service against the real database.
 *
 * RUNS IN ITS OWN SCHEMA, created and dropped per run. An earlier version seeded into the
 * live schema and asserted that its back-dated hours were rolled up — which failed, but
 * correctly: the rollup watermark had already advanced past them, and the service is right
 * to refuse to re-scan hours it has already counted. That coupling made the script depend
 * on how much history happened to exist, which is precisely what a verification must not
 * do. A fresh schema costs one migrate and removes the whole class of problem.
 *
 * Note the assumption this exposes: back-dated inserts can slip behind the watermark and
 * be pruned uncounted. Production cannot do that — `createdAt` defaults to the hub's own
 * insertion clock, so an event never arrives for an hour already past — but a seeding
 * script can, which is why it needs its own schema rather than a cleverer assertion.
 *
 *   node hub/scripts/verify-retention.cjs
 */
const { PrismaClient } = require('@prisma/client');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { RetentionService, startOfHour } = require('../dist/maintenance/retention.service');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PROBE = 'retention-probe';
const SCRATCH_SCHEMA = 'retention_verify';

/** Reads DATABASE_URL from hub/.env and points it at the scratch schema. */
function scratchUrl() {
  const text = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  const match = /^DATABASE_URL=(.*)$/m.exec(text);
  if (!match) throw new Error('No DATABASE_URL in hub/.env');

  const url = new URL(match[1].trim());
  url.searchParams.set('schema', SCRATCH_SCHEMA);
  return url.toString();
}


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

function buildService(prisma, windows) {
  const settings = {
    'retention.sweepCron': '0 30 3 * * *',
    'retention.eventDays': windows.eventDays,
    'retention.alertDays': windows.alertDays,
    'retention.notificationDays': windows.notificationDays,
    // Deliberately tiny, so the seeded rows take several batches and the loop's
    // stop condition is actually exercised rather than short-circuited.
    'retention.batchSize': 2,
    'retention.maxBatches': 50,
    'retention.batchPauseMs': 0,
  };

  return new RetentionService(prisma, { get: (key) => settings[key] }, { addCronJob: () => {} });
}

async function seed(prisma, base) {
  await cleanup(prisma);

  await prisma.agent.create({
    data: { id: PROBE, type: 'motion', location: 'verification', status: 'online' },
  });

  const hours = {
    old: new Date(base.getTime() - 40 * DAY_MS),
    olderNextHour: new Date(base.getTime() - 40 * DAY_MS + HOUR_MS),
    recent: new Date(base.getTime() - 10 * DAY_MS),
  };

  const rows = [
    ...Array.from({ length: 3 }, (_, i) => ({ at: new Date(hours.old.getTime() + i * 60_000) })),
    ...Array.from({ length: 2 }, (_, i) => ({
      at: new Date(hours.olderNextHour.getTime() + i * 60_000),
    })),
    ...Array.from({ length: 3 }, (_, i) => ({ at: new Date(hours.recent.getTime() + i * 60_000) })),
    // In the still-open hour: must be counted by no rollup and deleted by no prune.
    ...Array.from({ length: 2 }, (_, i) => ({ at: new Date(base.getTime() + i * 60_000) })),
  ];

  await prisma.event.createMany({
    data: rows.map(({ at }) => ({
      agentId: PROBE,
      type: 'motion_detected',
      metadata: {},
      occurredAt: at,
      createdAt: at,
    })),
  });

  const oldAlert = new Date(base.getTime() - 100 * DAY_MS);

  await prisma.alert.createMany({
    data: [
      {
        type: 'intrusion_motion',
        severity: 'warning',
        message: 'probe: acknowledged and old',
        agentId: PROBE,
        modeAtTrigger: 'away',
        acknowledged: true,
        acknowledgedAt: oldAlert,
        createdAt: oldAlert,
      },
      {
        type: 'intrusion_motion',
        severity: 'critical',
        message: 'probe: never acknowledged',
        agentId: PROBE,
        modeAtTrigger: 'away',
        acknowledged: false,
        createdAt: oldAlert,
      },
    ],
  });

  return hours;
}

async function cleanup(prisma) {
  await prisma.alert.deleteMany({ where: { agentId: PROBE } });
  await prisma.event.deleteMany({ where: { agentId: PROBE } });
  await prisma.eventRollup.deleteMany({ where: { agentId: PROBE } });
  await prisma.agent.deleteMany({ where: { id: PROBE } });
}

async function main() {
  const url = scratchUrl();

  // migrate deploy creates the schema and every table in it. Quiet unless it fails,
  // because a wall of migration output would bury the checks below.
  console.log(`--- provisioning scratch schema "${SCRATCH_SCHEMA}" ---`);
  // Prisma's CLI entry point run through node directly, rather than `pnpm exec`: Node
  // refuses to spawn a .cmd shim without a shell on Windows, and resolving the module is
  // both portable and one process cheaper.
  execFileSync(
    process.execPath,
    [
      require.resolve('prisma/build/index.js'),
      'migrate',
      'deploy',
      '--schema=./prisma/schema.prisma',
    ],
    { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' },
  );
  console.log('ok   scratch schema ready\n');

  const prisma = new PrismaClient({ datasourceUrl: url });
  const base = startOfHour(new Date());

  try {
    console.log('--- setup: seed a throwaway agent with aged history ---');
    const hours = await seed(prisma, base);
    ok('seeded', (await prisma.event.count({ where: { agentId: PROBE } })) === 10);

    console.log('\n--- sweep 1: roll up, then prune ---');
    const service = buildService(prisma, { eventDays: 30, alertDays: 90, notificationDays: 90 });
    const result = await service.sweep();
    ok('the sweep completed', result !== null);

    const rollups = await prisma.eventRollup.findMany({
      where: { agentId: PROBE },
      orderBy: { hour: 'asc' },
    });
    const bucket = (at) => rollups.find((r) => r.hour.getTime() === at.getTime());

    console.log(`     ${rollups.length} bucket(s) for the probe agent`);
    ok('every seeded hour got a bucket', rollups.length === 3, `saw ${rollups.length}`);
    ok('counts are exact, not approximated', bucket(hours.old)?.count === 3);
    ok('a second hour in the same day is its own bucket', bucket(hours.olderNextHour)?.count === 2);
    ok('the recent hour is counted too', bucket(hours.recent)?.count === 3);
    ok('the still-open current hour is NOT counted', bucket(base) === undefined);

    const survivors = await prisma.event.findMany({
      where: { agentId: PROBE },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`     ${survivors.length} of 10 events survived a 30-day window`);
    ok('events past the window are gone', survivors.length === 5, `saw ${survivors.length}`);
    ok(
      'the 40-day-old events specifically were deleted',
      survivors.every((e) => e.createdAt.getTime() > base.getTime() - 30 * DAY_MS),
    );
    ok(
      'their counts survive them in the rollup',
      (bucket(hours.old)?.count ?? 0) + (bucket(hours.olderNextHour)?.count ?? 0) === 5,
    );

    const alerts = await prisma.alert.findMany({ where: { agentId: PROBE } });
    ok('the acknowledged old alert was pruned', !alerts.some((a) => a.acknowledged));
    ok(
      'the UNACKNOWLEDGED old alert survived, at 100 days',
      alerts.some((a) => !a.acknowledged),
      'an open incident was aged out — the one thing retention must never do',
    );

    console.log('\n--- sweep 2: a repeat run must not double anything ---');
    const before = await prisma.eventRollup.findMany({
      where: { agentId: PROBE },
      orderBy: { hour: 'asc' },
    });
    await service.sweep();
    const after = await prisma.eventRollup.findMany({
      where: { agentId: PROBE },
      orderBy: { hour: 'asc' },
    });

    ok('no bucket was duplicated', after.length === before.length);
    ok(
      'no count was inflated',
      after.every((row, i) => row.count === before[i].count),
      `before ${before.map((r) => r.count)} after ${after.map((r) => r.count)}`,
    );
    ok(
      'the surviving events were left alone',
      (await prisma.event.count({ where: { agentId: PROBE } })) === 5,
    );

    console.log('\n--- windows of 0 delete nothing ---');
    const inert = buildService(prisma, { eventDays: 0, alertDays: 0, notificationDays: 0 });
    await inert.sweep();
    ok(
      'no events deleted with the shipped defaults',
      (await prisma.event.count({ where: { agentId: PROBE } })) === 5,
    );
    ok(
      'no alerts deleted with the shipped defaults',
      (await prisma.alert.count({ where: { agentId: PROBE } })) === 1,
    );
  } finally {
    // Dropping the schema is the cleanup. Safe by construction: it is created by this
    // script, named distinctly, and never holds anything but seeded rows.
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCRATCH_SCHEMA}" CASCADE`);
    await prisma.$disconnect();
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
