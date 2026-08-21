/**
 * End-to-end check of the audit trail against the running hub.
 *
 * Exercises the real HTTP surface with real credentials, because the interesting claims
 * here are about what the guard, the policy layer, and the recorder do together — none
 * of which a unit test with a mocked Prisma can prove.
 *
 * Restores what it changes: the system mode is put back, and every row it created is
 * removed afterwards, including its own audit entries. Deleting them is the point — a
 * verification run must not leave fake incidents in a real security trail.
 *
 *   node hub/scripts/verify-audit.cjs
 */
const { PrismaClient } = require('@prisma/client');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const BASE = process.env.HUB_URL ?? 'http://localhost:3000';
const PROBE = 'audit-probe-camera';

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

/** Reads the same .env the hub booted from, so the script cannot drift from it. */
function loadEnv() {
  const text = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  const env = {};

  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2].trim();
  }
  return env;
}

async function call(method, path, { key, label, body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(label ? { 'x-operator-label': label } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, body: json };
}

async function main() {
  const env = loadEnv();
  const operator = env.OPERATOR_KEY;
  const admin = env.ADMIN_KEY;
  const viewer = env.VIEWER_KEY;
  const bootstrap = env.AGENT_BOOTSTRAP_KEY;

  const prisma = new PrismaClient();
  const startedAt = new Date();
  let originalMode = 'disarmed';

  try {
    const health = await call('GET', '/health');
    if (health.status !== 200) {
      console.error(`Hub not reachable at ${BASE} (status ${health.status}). Start it first.`);
      process.exit(1);
    }

    originalMode = (await call('GET', '/system/mode', { key: operator })).body?.mode ?? 'disarmed';

    console.log('--- an allowed mode change is recorded ---');
    const armed = await call('POST', '/system/mode', {
      key: operator,
      label: 'Ada Lovelace',
      body: { mode: 'away' },
    });
    ok('the operator could arm', armed.status === 200, `status ${armed.status}`);

    let rows = await prisma.auditLog.findMany({
      where: { at: { gte: startedAt }, action: 'mode_changed' },
      orderBy: { at: 'desc' },
    });
    const armRow = rows[0];
    ok('an audit row was written', Boolean(armRow));
    ok('the outcome is allowed', armRow?.outcome === 'allowed');
    ok('the role came from the credential', armRow?.actor === 'operator');
    ok('the transition is recorded, not just the destination', armRow?.detail?.to === 'away');
    ok('the claimed label was kept', armRow?.actorLabel === 'Ada Lovelace');

    console.log('\n--- a REFUSED disarm is recorded, which is the point ---');
    // Inserted directly: the policy needs an open critical alert to refuse against, and
    // manufacturing one through the sensors would be slower and less deterministic.
    const blocker = await prisma.alert.create({
      data: {
        type: 'intrusion_motion',
        severity: 'critical',
        message: 'audit probe: unacknowledged critical',
        modeAtTrigger: 'away',
        acknowledged: false,
      },
    });

    const refused = await call('POST', '/system/mode', {
      key: operator,
      label: 'Ada Lovelace',
      body: { mode: 'disarmed' },
    });
    ok('the operator was refused', refused.status === 403, `status ${refused.status}`);

    const deniedRow = await prisma.auditLog.findFirst({
      where: { at: { gte: startedAt }, action: 'mode_changed', outcome: 'denied' },
      orderBy: { at: 'desc' },
    });
    ok('the refusal was recorded', Boolean(deniedRow));
    ok('it carries the reason the human was given', Boolean(deniedRow?.reason));
    ok(
      'it records which role could have done it instead',
      deniedRow?.detail?.requiresRole === 'admin',
      JSON.stringify(deniedRow?.detail),
    );

    console.log('\n--- acknowledging is recorded, then the disarm succeeds ---');
    const acked = await call('POST', `/alerts/${blocker.id}/ack`, {
      key: operator,
      label: 'Ada Lovelace',
    });
    ok('the alert was acknowledged', acked.status === 200, `status ${acked.status}`);

    const ackRow = await prisma.auditLog.findFirst({
      where: { at: { gte: startedAt }, action: 'alert_acknowledged' },
      orderBy: { at: 'desc' },
    });
    ok('taking responsibility for an incident is on the record', ackRow?.outcome === 'allowed');
    ok('it points at the alert', ackRow?.targetId === blocker.id);

    // Any OTHER open critical alert blocks the operator just as validly, and this runs
    // against a live database that has its own history. Only assert the clean case when
    // the system is genuinely clear.
    const stillBlocking = await prisma.alert.count({
      where: { severity: 'critical', acknowledged: false },
    });

    if (stillBlocking === 0) {
      const disarmed = await call('POST', '/system/mode', {
        key: operator,
        body: { mode: 'disarmed' },
      });
      ok('the same disarm now succeeds', disarmed.status === 200, `status ${disarmed.status}`);
    } else {
      console.log(
        `     skipped: ${stillBlocking} other unacknowledged critical alert(s) still block it`,
      );
    }

    console.log('\n--- the admin override is allowed, and audited as such ---');
    const override = await call('POST', '/system/mode', {
      key: admin,
      label: 'Grace Hopper',
      body: { mode: 'disarmed' },
    });
    ok('an admin can disarm regardless', override.status === 200, `status ${override.status}`);

    const overrideRow = await prisma.auditLog.findFirst({
      where: { at: { gte: startedAt }, action: 'mode_changed', outcome: 'allowed', actor: 'admin' },
      orderBy: { at: 'desc' },
    });
    ok('the override is on the record, not silent', Boolean(overrideRow));
    ok('it is attributed to the admin role', overrideRow?.actor === 'admin');

    console.log('\n--- a self-asserted label is sanitised in the live path ---');
    // Control characters are covered by the unit test: fetch refuses to send them, and
    // so would a browser. What a real client CAN send is an absurdly long label, so
    // that is what proves the sanitiser runs on the way in rather than only in a test.
    await call('POST', '/system/mode', {
      key: operator,
      label: 'M'.repeat(500),
      body: { mode: 'home' },
    });
    const capped = await prisma.auditLog.findFirst({
      where: { at: { gte: startedAt }, action: 'mode_changed', actor: 'operator' },
      orderBy: { at: 'desc' },
    });
    ok('the label was capped at 64', capped?.actorLabel?.length === 64, `${capped?.actorLabel?.length}`);
    ok('the role is still what the credential proved', capped?.actor === 'operator');

    console.log('\n--- enrollment and rotation are distinguishable ---');
    const first = await call('POST', '/agents/register', {
      key: bootstrap,
      body: { id: PROBE, type: 'camera', location: 'verification' },
    });
    ok('the probe agent enrolled', first.status === 200, `status ${first.status}`);

    const second = await call('POST', '/agents/register', {
      key: bootstrap,
      body: { id: PROBE, type: 'camera', location: 'verification' },
    });
    ok('re-enrollment succeeded', second.status === 200);
    ok('the hub reports it rotated', second.body?.enrollment?.rotated === true);

    const agentRows = await prisma.auditLog.findMany({
      where: { at: { gte: startedAt }, targetId: PROBE },
      orderBy: { at: 'asc' },
    });
    ok('the first is an enrollment', agentRows[0]?.action === 'agent_enrolled');
    ok(
      'the second is a ROTATION, the security-relevant event',
      agentRows[1]?.action === 'agent_token_rotated',
      agentRows.map((r) => r.action).join(', '),
    );
    ok('the bootstrap role is attributed', agentRows[0]?.actor === 'bootstrap');

    console.log('\n--- camera viewing is recorded once per session, not per retry ---');
    for (let i = 0; i < 6; i += 1) {
      await call('POST', `/cameras/${PROBE}/ticket`, { key: operator, label: 'Ada Lovelace' });
    }
    const viewRows = await prisma.auditLog.findMany({
      where: { at: { gte: startedAt }, action: 'camera_viewed', targetId: PROBE },
    });
    console.log(`     6 tickets minted -> ${viewRows.length} audit row(s)`);
    ok('the burst collapsed to one row', viewRows.length === 1, `saw ${viewRows.length}`);

    console.log('\n--- reading the trail is admin-only ---');
    const asOperator = await call('GET', '/audit', { key: operator });
    ok('an operator is refused', asOperator.status === 403, `status ${asOperator.status}`);

    if (viewer) {
      const asViewer = await call('GET', '/audit', { key: viewer });
      ok('a viewer is refused', asViewer.status === 403, `status ${asViewer.status}`);
    }

    const asAdmin = await call('GET', '/audit', { key: admin });
    ok('an admin can read it', asAdmin.status === 200, `status ${asAdmin.status}`);
    ok('entries come back', Array.isArray(asAdmin.body) && asAdmin.body.length > 0);
    ok(
      'newest first',
      asAdmin.body.length < 2 ||
        new Date(asAdmin.body[0].at) >= new Date(asAdmin.body[1].at),
    );
    ok(
      'no entry leaks credential material',
      !JSON.stringify(asAdmin.body).match(/(tokenHash|Bearer|ag_[A-Za-z0-9_-]{20})/),
    );

    const denials = await call('GET', '/audit?outcome=denied', { key: admin });
    ok(
      'the denials filter returns only refusals',
      denials.status === 200 && denials.body.every((e) => e.outcome === 'denied'),
    );

    console.log('\n--- there is no way to write to the trail ---');
    const forge = await call('POST', '/audit', {
      key: admin,
      body: { action: 'mode_changed', outcome: 'allowed' },
    });
    ok('POST /audit does not exist', forge.status === 404, `status ${forge.status}`);
  } finally {
    // Restore the mode, then erase everything this run produced. Leaving fake incidents
    // in a real security trail would be worse than not testing it.
    await call('POST', '/system/mode', { key: env.ADMIN_KEY, body: { mode: originalMode } });
    await prisma.auditLog.deleteMany({ where: { at: { gte: startedAt } } });
    await prisma.alert.deleteMany({ where: { message: { startsWith: 'audit probe:' } } });
    await prisma.event.deleteMany({ where: { agentId: PROBE } });
    await prisma.agent.deleteMany({ where: { id: PROBE } });
    await prisma.$disconnect();
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
