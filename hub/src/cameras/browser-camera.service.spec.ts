import {
  AgentOrigin,
  AgentType,
  BROWSER_CAMERA_ID_PREFIX,
  BROWSER_SESSION_TTL_MS,
  MAX_BROWSER_CAMERAS,
} from '@cpe310/contracts';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { hashToken } from '../common/security/tokens';
import { BrowserCameraService } from './browser-camera.service';

async function buildService(
  options: { live?: number; existing?: { id: string; origin: string } | null } = {},
) {
  const { live = 0, existing = null } = options;

  const prisma = {
    agent: {
      count: jest.fn().mockResolvedValue(live),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)),
      findUnique: jest.fn().mockResolvedValue(existing),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };

  const moduleRef = await Test.createTestingModule({
    providers: [BrowserCameraService, { provide: PrismaService, useValue: prisma }],
  }).compile();

  return { service: moduleRef.get(BrowserCameraService), prisma };
}

describe('BrowserCameraService.create', () => {
  it('names the camera itself, in the reserved namespace', async () => {
    // This is the property that stops a browser feed being called `camera-lobby` and
    // passed off as the real lobby camera. The client never gets to choose.
    const { service } = await buildService();

    const session = await service.create('Front Office');

    expect(session.agentId.startsWith(BROWSER_CAMERA_ID_PREFIX)).toBe(true);
  });

  it('generates a distinct id every time', async () => {
    const { service } = await buildService();

    const ids = new Set(
      await Promise.all(
        Array.from({ length: 20 }, async () => (await service.create('Room')).agentId),
      ),
    );

    expect(ids.size).toBe(20);
  });

  it('marks the row browser-origin, which is the hub-set label the UI trusts', async () => {
    const { service, prisma } = await buildService();

    await service.create('Front Office');

    const data = prisma.agent.create.mock.calls[0][0].data;
    expect(data.origin).toBe(AgentOrigin.Browser);
    expect(data.type).toBe(AgentType.Camera);
    expect(data.capabilities).toContain('browser');
  });

  it('stores only a HASH of the token it hands back', async () => {
    const { service, prisma } = await buildService();

    const session = await service.create('Front Office');

    const data = prisma.agent.create.mock.calls[0][0].data;
    expect(data.tokenHash).toBe(hashToken(session.token));
    expect(JSON.stringify(data)).not.toContain(session.token);
  });

  it('gives the token a short expiry, unlike a device token', async () => {
    // The answer to a laptop left publishing in an empty meeting room.
    const { service, prisma } = await buildService();

    await service.create('Front Office');

    const data = prisma.agent.create.mock.calls[0][0].data;
    const ttl = data.tokenExpiresAt.getTime() - data.tokenIssuedAt.getTime();
    expect(ttl).toBe(BROWSER_SESSION_TTL_MS);
  });

  it('refuses once the cap is reached', async () => {
    // Bounds how much of the camera wall can be video an operator supplied.
    const { service } = await buildService({ live: MAX_BROWSER_CAMERAS });

    await expect(service.create('Front Office')).rejects.toThrow(/limit/i);
  });

  it('counts only sessions with a live token toward the cap', async () => {
    // A revoked session nulls its hash, so it must not occupy a slot forever.
    const { service, prisma } = await buildService();

    await service.create('Front Office');

    expect(prisma.agent.count.mock.calls[0][0].where).toEqual({
      origin: AgentOrigin.Browser,
      tokenHash: { not: null },
    });
  });

  it('keeps the caller’s label as a display note, not as anything load-bearing', async () => {
    const { service, prisma } = await buildService();

    await service.create('Front Office', "Ada's laptop");

    expect(prisma.agent.create.mock.calls[0][0].data.location).toContain("Ada's laptop");
  });
});

describe('BrowserCameraService.renew', () => {
  it('rotates the token, invalidating any copy of the old one', async () => {
    const { service, prisma } = await buildService({
      existing: { id: 'browser-abc123', origin: AgentOrigin.Browser },
    });

    const session = await service.renew('browser-abc123');

    const data = prisma.agent.update.mock.calls[0][0].data;
    expect(data.tokenHash).toBe(hashToken(session.token));
    expect(data.tokenRotations).toEqual({ increment: 1 });
  });

  it('extends the expiry', async () => {
    const { service, prisma } = await buildService({
      existing: { id: 'browser-abc123', origin: AgentOrigin.Browser },
    });

    await service.renew('browser-abc123');

    expect(prisma.agent.update.mock.calls[0][0].data.tokenExpiresAt.getTime()).toBeGreaterThan(
      Date.now(),
    );
  });
});

describe('BrowserCameraService.revoke', () => {
  it('nulls the hash so the token stops resolving immediately', async () => {
    const { service, prisma } = await buildService({
      existing: { id: 'browser-abc123', origin: AgentOrigin.Browser },
    });

    await service.revoke('browser-abc123');

    expect(prisma.agent.update.mock.calls[0][0].data.tokenHash).toBeNull();
  });

  it('does NOT delete the row', async () => {
    // The agent, its events, and its audit entries stay readable — which is the point of
    // having recorded them.
    const { service, prisma } = await buildService({
      existing: { id: 'browser-abc123', origin: AgentOrigin.Browser },
    });

    await service.revoke('browser-abc123');

    expect(prisma.agent).not.toHaveProperty('delete');
    expect(prisma.agent.update).toHaveBeenCalled();
  });
});

describe('BrowserCameraService scope', () => {
  it('refuses to renew a DEVICE agent', async () => {
    // Otherwise these endpoints would be a way to rotate a real sensor's credential out
    // from under it — a denial of service against the fleet dressed as session management.
    const { service } = await buildService({
      existing: { id: 'door-front', origin: AgentOrigin.Device },
    });

    await expect(service.renew('door-front')).rejects.toThrow(/No browser camera/);
  });

  it('refuses to revoke a DEVICE agent', async () => {
    const { service } = await buildService({
      existing: { id: 'door-front', origin: AgentOrigin.Device },
    });

    await expect(service.revoke('door-front')).rejects.toThrow(/No browser camera/);
  });

  it('404s on an unknown id', async () => {
    const { service } = await buildService({ existing: null });

    await expect(service.revoke('nope')).rejects.toThrow(/No browser camera/);
  });
});

describe('BrowserCameraService.activeIds', () => {
  it('lists only sessions that can still publish', async () => {
    // Revoke keeps the row so history survives, but a session with no credential can
    // never send another frame — leaving it on the camera wall means a permanently dead
    // tile nobody can account for or remove.
    const { service, prisma } = await buildService();
    prisma.agent.findMany.mockResolvedValue([{ id: 'browser-abc123' }]);

    const active = await service.activeIds();

    expect(active.has('browser-abc123')).toBe(true);
    expect(prisma.agent.findMany.mock.calls[0][0].where).toEqual({
      origin: AgentOrigin.Browser,
      tokenHash: { not: null },
    });
  });
});

describe('BrowserCameraService.reapEndedSessions', () => {
  it('removes only tokenless browser rows past a full session TTL', async () => {
    const { service, prisma } = await buildService();
    prisma.agent.deleteMany.mockResolvedValue({ count: 2 });
    const now = new Date('2026-08-18T12:00:00.000Z');

    const reaped = await service.reapEndedSessions(now);

    expect(reaped).toBe(2);
    const where = prisma.agent.deleteMany.mock.calls[0][0].where;
    expect(where.origin).toBe(AgentOrigin.Browser);
    // An ACTIVE session must never be at risk, so the token must already be gone.
    expect(where.tokenHash).toBeNull();
    expect(where.lastSeenAt.lt.getTime()).toBe(now.getTime() - BROWSER_SESSION_TTL_MS);
  });

  it('never touches a device agent — a silent sensor is evidence, not litter', async () => {
    const { service, prisma } = await buildService();

    await service.reapEndedSessions(new Date());

    expect(prisma.agent.deleteMany.mock.calls[0][0].where.origin).toBe(AgentOrigin.Browser);
  });
});
