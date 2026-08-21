import { AuthRole, Permission, permissionsForRole } from '@cpe310/contracts';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import { CredentialService } from './credential.service';
import { hashToken, mintAgentToken } from './tokens';

const BOOTSTRAP = 'a-real-bootstrap-secret';
const OPERATOR = 'a-real-operator-secret';
const VIEWER = 'a-real-viewer-secret';
const ADMIN = 'a-real-admin-secret';
const ZONES = ['Hallway', 'Lobby'];

async function buildService(
  agentForHash: { id: string; tokenExpiresAt?: Date | null } | null = null,
  overrides: { viewer?: string; admin?: string } = { viewer: VIEWER, admin: ADMIN },
) {
  const prisma = {
    agent: { findUnique: jest.fn().mockResolvedValue(agentForHash) },
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'auth.bootstrapKey') return BOOTSTRAP;
      if (key === 'auth.operatorKey') return OPERATOR;
      if (key === 'auth.viewerKey') return 'viewer' in overrides ? overrides.viewer : VIEWER;
      if (key === 'auth.adminKey') return 'admin' in overrides ? overrides.admin : ADMIN;
      if (key === 'auth.viewerZones') return ZONES;
      return undefined;
    }),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      CredentialService,
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();

  return { service: moduleRef.get(CredentialService), prisma };
}

describe('CredentialService.resolve', () => {
  it('recognises the operator key and attaches its permissions', async () => {
    const { service } = await buildService();

    const identity = await service.resolve(OPERATOR);

    expect(identity?.role).toBe(AuthRole.Operator);
    // Permissions come from the shared role map, not from the call site.
    expect(identity?.permissions).toEqual(permissionsForRole(AuthRole.Operator));
    expect(identity?.zones).toEqual([]);
  });

  it('recognises the admin key', async () => {
    const { service } = await buildService();

    const identity = await service.resolve(ADMIN);

    expect(identity?.role).toBe(AuthRole.Admin);
    expect(identity?.permissions).toContain(Permission.NotificationsRead);
  });

  it('recognises the viewer key and applies its zones', async () => {
    // The attribute-based half: same role, different entitlement.
    const { service } = await buildService();

    const identity = await service.resolve(VIEWER);

    expect(identity?.role).toBe(AuthRole.Viewer);
    expect(identity?.zones).toEqual(['Hallway', 'Lobby']);
    expect(identity?.permissions).not.toContain(Permission.SystemDisarm);
  });

  it('does not zone-restrict operators or admins', async () => {
    const { service } = await buildService();

    expect((await service.resolve(OPERATOR))?.zones).toEqual([]);
    expect((await service.resolve(ADMIN))?.zones).toEqual([]);
  });

  it('recognises the bootstrap key', async () => {
    const { service } = await buildService();

    const identity = await service.resolve(BOOTSTRAP);

    expect(identity?.role).toBe(AuthRole.Bootstrap);
    // Enrollment only — it cannot read anything.
    expect(identity?.permissions).toEqual([Permission.AgentsEnroll]);
  });

  it('returns null for a viewer key when the role is not configured', async () => {
    const { service } = await buildService(null, { viewer: undefined });

    await expect(service.resolve(VIEWER)).resolves.toBeNull();
  });

  it('resolves a valid agent token to its owning agent', async () => {
    const { token } = mintAgentToken();
    const { service, prisma } = await buildService({ id: 'motion-hallway' });

    const identity = await service.resolve(token);

    expect(identity?.role).toBe(AuthRole.Agent);
    expect(identity?.agentId).toBe('motion-hallway');
    expect(identity?.permissions).toEqual(permissionsForRole(AuthRole.Agent));
    // Looked up by hash, never by plaintext — the hub stores no plaintext to match.
    expect(prisma.agent.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashToken(token) },
      select: { id: true, tokenExpiresAt: true },
    });
  });

  it('accepts a token with no expiry, which is what a dedicated device has', async () => {
    const { token } = mintAgentToken();
    const { service } = await buildService({ id: 'door-front', tokenExpiresAt: null });

    expect((await service.resolve(token))?.agentId).toBe('door-front');
  });

  it('refuses an EXPIRED token', async () => {
    // Browser cameras get a short expiry so a publishing credential cannot outlive the
    // person who created it. Enforced here rather than at the publish endpoint, so it
    // covers every route the token could reach.
    const { token } = mintAgentToken();
    const { service } = await buildService({
      id: 'browser-abc123',
      tokenExpiresAt: new Date(Date.now() - 1_000),
    });

    await expect(service.resolve(token)).resolves.toBeNull();
  });

  it('accepts a token whose expiry is still ahead', async () => {
    const { token } = mintAgentToken();
    const { service } = await buildService({
      id: 'browser-abc123',
      tokenExpiresAt: new Date(Date.now() + 60_000),
    });

    expect((await service.resolve(token))?.agentId).toBe('browser-abc123');
  });

  it('returns null for a token-shaped string that no agent owns', async () => {
    const { service } = await buildService(null);

    await expect(service.resolve('ag_not-a-real-token')).resolves.toBeNull();
  });

  it('does not hit the database for a credential that is not token-shaped', async () => {
    // Otherwise every bad guess costs a query, which is a cheap amplification.
    const { service, prisma } = await buildService();

    await expect(service.resolve('totally-wrong')).resolves.toBeNull();
    expect(prisma.agent.findUnique).not.toHaveBeenCalled();
  });

  it('returns null for an empty credential', async () => {
    const { service, prisma } = await buildService();

    await expect(service.resolve('')).resolves.toBeNull();
    expect(prisma.agent.findUnique).not.toHaveBeenCalled();
  });

  it('does not treat a near-miss of the operator key as valid', async () => {
    const { service } = await buildService();

    await expect(service.resolve(OPERATOR.toUpperCase())).resolves.toBeNull();
  });
});
