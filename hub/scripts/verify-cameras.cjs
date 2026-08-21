/**
 * End-to-end check of camera provisioning against the running hub.
 *
 * The claims worth proving here are all about AUTHORISATION and LABELLING — that only an
 * admin can mint a publishing credential, that the hub and not the client names the
 * camera, that such a feed is marked as browser-origin everywhere it is reported, and
 * that a device token cannot be created in the browser namespace. None of that can be
 * shown by a unit test with a mocked Prisma.
 *
 * Cleans up everything it creates.
 *
 *   node hub/scripts/verify-cameras.cjs
 */
const { PrismaClient } = require('@prisma/client');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const BASE = process.env.HUB_URL ?? 'http://localhost:3000';
const PROBE_LOCATION = 'verify-probe-location';

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

async function call(method, path, { key, body, raw, contentType } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(contentType ? { 'content-type': contentType } : body ? { 'content-type': 'application/json' } : {}),
    },
    ...(raw ? { body: raw } : body ? { body: JSON.stringify(body) } : {}),
  });

  const text = raw ? '' : await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, body: json };
}

/** A minimal but structurally valid JPEG, so the hub's dimension parser is exercised. */
function jpeg(width = 320, height = 240) {
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  const dims = Buffer.alloc(4);
  dims.writeUInt16BE(height, 0);
  dims.writeUInt16BE(width, 2);
  return Buffer.concat([header, dims, Buffer.from([0xff, 0xd9])]);
}

async function main() {
  const env = loadEnv();
  const prisma = new PrismaClient();
  const startedAt = new Date();
  const created = [];

  try {
    if ((await call('GET', '/health')).status !== 200) {
      console.error(`Hub not reachable at ${BASE}. Start it first.`);
      process.exit(1);
    }

    console.log('--- provisioning is admin-only ---');
    for (const [role, key] of [
      ['operator', env.OPERATOR_KEY],
      ['viewer', env.VIEWER_KEY],
      ['bootstrap', env.AGENT_BOOTSTRAP_KEY],
    ]) {
      if (!key) continue;
      const refused = await call('POST', '/cameras/browser-sessions', {
        key,
        body: { location: PROBE_LOCATION },
      });
      ok(`${role} is refused`, refused.status === 403, `status ${refused.status}`);
    }

    const session = await call('POST', '/cameras/browser-sessions', {
      key: env.ADMIN_KEY,
      body: { location: PROBE_LOCATION, label: 'verify probe' },
    });
    ok('an admin can mint one', session.status === 201, `status ${session.status}`);
    if (session.status !== 201) throw new Error('cannot continue without a session');
    created.push(session.body.agentId);

    console.log('\n--- the HUB names the camera, not the client ---');
    ok('the id is in the reserved namespace', session.body.agentId.startsWith('browser-'));
    ok('a token came back exactly once', typeof session.body.token === 'string');
    ok('it carries an expiry', Boolean(session.body.expiresAt));

    const ignored = await call('POST', '/cameras/browser-sessions', {
      key: env.ADMIN_KEY,
      body: {
        location: PROBE_LOCATION,
        // Every one of these is an attempt to look like real hardware. The DTO omits
        // them and the ValidationPipe strips them, so none should have any effect.
        id: 'camera-lobby',
        agentId: 'camera-lobby',
        type: 'door',
        origin: 'device',
        capabilities: ['camera', 'mog2'],
      },
    });
    ok('a client-chosen id is ignored', ignored.status === 201);
    if (ignored.status === 201) {
      created.push(ignored.body.agentId);
      ok(
        'it did NOT become camera-lobby',
        ignored.body.agentId !== 'camera-lobby' && ignored.body.agentId.startsWith('browser-'),
        ignored.body.agentId,
      );

      const row = await prisma.agent.findUnique({ where: { id: ignored.body.agentId } });
      ok('the hub forced origin=browser', row.origin === 'browser');
      ok('the hub forced type=camera', row.type === 'camera');
      ok('capabilities say browser', row.capabilities.includes('browser'));
      ok('only a token HASH is stored', !JSON.stringify(row).includes(ignored.body.token));
    }

    console.log('\n--- the reserved namespace cannot be squatted from the device path ---');
    const squat = await call('POST', '/agents/register', {
      key: env.AGENT_BOOTSTRAP_KEY,
      body: { id: 'browser-squatted', type: 'camera', location: PROBE_LOCATION },
    });
    ok('enrolling a browser- id is refused', squat.status === 400, `status ${squat.status}`);

    console.log('\n--- the minted token publishes, and only as itself ---');
    const publish = await call('POST', `/cameras/${session.body.agentId}/frame`, {
      key: session.body.token,
      raw: jpeg(),
      contentType: 'image/jpeg',
    });
    ok('it can publish its own frames', publish.status === 201, `status ${publish.status}`);

    const impersonate = await call('POST', '/cameras/camera-demo/frame', {
      key: session.body.token,
      raw: jpeg(),
      contentType: 'image/jpeg',
    });
    ok(
      'it CANNOT publish as another camera',
      impersonate.status === 403,
      `status ${impersonate.status}`,
    );

    const asAdmin = await call('POST', `/cameras/${session.body.agentId}/frame`, {
      key: env.ADMIN_KEY,
      raw: jpeg(),
      contentType: 'image/jpeg',
    });
    ok(
      'a human credential cannot publish at all',
      asAdmin.status === 403,
      `status ${asAdmin.status}`,
    );

    console.log('\n--- the feed is labelled wherever it is reported ---');
    const list = await call('GET', '/cameras', { key: env.OPERATOR_KEY });
    const mine = list.body.find((c) => c.agentId === session.body.agentId);
    ok('it appears in GET /cameras', Boolean(mine));
    ok('marked origin=browser', mine?.origin === 'browser');
    ok('and it is streaming after one frame', mine?.streaming === true);

    const agents = await call('GET', '/agents', { key: env.OPERATOR_KEY });
    ok(
      'GET /agents reports origin too',
      agents.body.find((a) => a.id === session.body.agentId)?.origin === 'browser',
    );
    ok(
      'a real device still reports origin=device',
      agents.body.find((a) => a.id === 'door-front')?.origin === 'device',
    );

    console.log('\n--- provisioning is audited ---');
    const audit = await prisma.auditLog.findFirst({
      where: { at: { gte: startedAt }, action: 'browser_camera_provisioned' },
      orderBy: { at: 'desc' },
    });
    ok('the mint is on the record', Boolean(audit));
    ok('attributed to the admin role', audit?.actor === 'admin');
    ok('naming the camera it created', audit?.targetId?.startsWith('browser-'));

    console.log('\n--- revoke kills the token immediately ---');
    const revoked = await call('DELETE', `/cameras/browser-sessions/${session.body.agentId}`, {
      key: env.ADMIN_KEY,
    });
    ok('revoke succeeds', revoked.status === 204, `status ${revoked.status}`);

    const afterRevoke = await call('POST', `/cameras/${session.body.agentId}/frame`, {
      key: session.body.token,
      raw: jpeg(),
      contentType: 'image/jpeg',
    });
    ok(
      'the token no longer publishes',
      afterRevoke.status === 401,
      `status ${afterRevoke.status}`,
    );

    const stillThere = await prisma.agent.findUnique({ where: { id: session.body.agentId } });
    ok('the agent row survives, so its history stays readable', Boolean(stillThere));
    ok('but holds no token', stillThere?.tokenHash === null);

    console.log('\n--- an expired token is refused ---');
    const expiring = await call('POST', '/cameras/browser-sessions', {
      key: env.ADMIN_KEY,
      body: { location: PROBE_LOCATION },
    });
    created.push(expiring.body.agentId);
    await prisma.agent.update({
      where: { id: expiring.body.agentId },
      data: { tokenExpiresAt: new Date(Date.now() - 1_000) },
    });

    const stale = await call('POST', `/cameras/${expiring.body.agentId}/frame`, {
      key: expiring.body.token,
      raw: jpeg(),
      contentType: 'image/jpeg',
    });
    ok('an expired token is rejected', stale.status === 401, `status ${stale.status}`);

    console.log('\n--- a browser camera is never swept offline ---');
    // The sweep's premise — silence means tampering — does not hold for a tab that the
    // browser throttled. Left unfiltered this would alert forever.
    await prisma.agent.update({
      where: { id: expiring.body.agentId },
      data: { lastSeenAt: new Date(Date.now() - 10 * 60_000), status: 'online' },
    });
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    const swept = await prisma.agent.findUnique({ where: { id: expiring.body.agentId } });
    ok('still marked online despite 10 minutes of silence', swept?.status === 'online');
    const offlineAlert = await prisma.alert.findFirst({
      where: { agentId: expiring.body.agentId, type: 'agent_offline' },
    });
    ok('and no agent_offline alert was raised', offlineAlert === null);
  } finally {
    for (const id of created) {
      await prisma.alert.deleteMany({ where: { agentId: id } });
      await prisma.event.deleteMany({ where: { agentId: id } });
      await prisma.agent.deleteMany({ where: { id } });
    }
    await prisma.agent.deleteMany({ where: { id: 'browser-squatted' } });
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
