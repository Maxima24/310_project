import {
  AuditAction,
  AuditActor,
  AuditOutcome,
  AuthRole,
  MAX_OPERATOR_LABEL_LENGTH,
  OPERATOR_LABEL_HEADER,
  Permission,
  ROLE_PERMISSIONS,
} from '@cpe310/contracts';
import { Test } from '@nestjs/testing';

import type { AuthenticatedRequest } from '../common/guards/auth.guard';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuditService, sanitizeLabel } from './audit.service';

async function buildService(createImpl?: jest.Mock) {
  const create = createImpl ?? jest.fn().mockResolvedValue({});
  const prisma = { auditLog: { create, findMany: jest.fn().mockResolvedValue([]) } };

  const moduleRef = await Test.createTestingModule({
    providers: [AuditService, { provide: PrismaService, useValue: prisma }],
  }).compile();

  return { service: moduleRef.get(AuditService), create, prisma };
}

/** Minimal stand-in for an authenticated Express request. */
function request(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    headers: {},
    ip: '10.0.0.5',
    identity: {
      role: AuthRole.Operator,
      permissions: ROLE_PERMISSIONS[AuthRole.Operator],
      zones: [],
    },
    ...overrides,
  } as AuthenticatedRequest;
}

describe('sanitizeLabel', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeLabel('  Ada Lovelace ')).toBe('Ada Lovelace');
  });

  it('strips control characters so a label cannot forge a second log line', () => {
    // A newline in a displayed audit line is how one entry is made to look like two.
    expect(sanitizeLabel('Ada\nDENIED admin override')).toBe('Ada DENIED admin override');
  });

  it('caps the length, past which it is a payload rather than a name', () => {
    expect(sanitizeLabel('x'.repeat(500))).toHaveLength(MAX_OPERATOR_LABEL_LENGTH);
  });

  it('treats a blank or non-string label as absent', () => {
    expect(sanitizeLabel('   ')).toBeUndefined();
    expect(sanitizeLabel(undefined)).toBeUndefined();
    expect(sanitizeLabel(42)).toBeUndefined();
  });
});

describe('AuditService.actorFromRequest', () => {
  it('takes the role from the resolved credential, which cannot be spoofed', async () => {
    const { service } = await buildService();

    expect(service.actorFromRequest(request()).actor).toBe(AuditActor.Operator);
  });

  it('records an agent token’s own id, the one identity here that is verified', async () => {
    const { service } = await buildService();

    const fields = service.actorFromRequest(
      request({
        identity: {
          role: AuthRole.Agent,
          permissions: ROLE_PERMISSIONS[AuthRole.Agent],
          zones: [],
          agentId: 'door-front',
        },
      }),
    );

    expect(fields.actor).toBe(AuditActor.Agent);
    expect(fields.actorAgentId).toBe('door-front');
  });

  it('carries the claimed label through, sanitised', async () => {
    const { service } = await buildService();

    const fields = service.actorFromRequest(
      request({ headers: { [OPERATOR_LABEL_HEADER]: ' Grace\tHopper ' } }),
    );

    expect(fields.actorLabel).toBe('Grace Hopper');
  });

  it('never lets a claimed label influence the recorded role', async () => {
    // The whole point of separating the two fields: the label is decoration, the role
    // is evidence, and a caller controls only the first.
    const { service } = await buildService();

    const fields = service.actorFromRequest(
      request({ headers: { [OPERATOR_LABEL_HEADER]: 'admin' } }),
    );

    expect(fields.actor).toBe(AuditActor.Operator);
  });

  it('falls back to the system actor when there is no identity', async () => {
    const { service } = await buildService();

    expect(service.actorFromRequest(request({ identity: undefined })).actor).toBe(
      AuditActor.System,
    );
  });
});

describe('AuditService.record', () => {
  it('writes the entry', async () => {
    const { service, create } = await buildService();

    await service.record({
      actor: AuditActor.Operator,
      action: AuditAction.ModeChanged,
      outcome: AuditOutcome.Allowed,
      detail: { from: 'disarmed', to: 'away' },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data).toMatchObject({
      action: AuditAction.ModeChanged,
      outcome: AuditOutcome.Allowed,
      actor: AuditActor.Operator,
    });
  });

  it('records denials, not only successes', async () => {
    const { service, create } = await buildService();

    await service.record({
      actor: AuditActor.Operator,
      action: AuditAction.ModeChanged,
      outcome: AuditOutcome.Denied,
      reason: 'A critical alert is unacknowledged',
    });

    expect(create.mock.calls[0][0].data).toMatchObject({
      outcome: AuditOutcome.Denied,
      reason: 'A critical alert is unacknowledged',
    });
  });

  it('swallows a write failure rather than breaking the action', async () => {
    // Refusing to let someone disarm the building because an audit row would not write
    // is a lock-in caused by bookkeeping. A logged gap is the better failure.
    const { service } = await buildService(jest.fn().mockRejectedValue(new Error('disk full')));

    await expect(
      service.record({
        actor: AuditActor.Admin,
        action: AuditAction.ModeChanged,
        outcome: AuditOutcome.Allowed,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('AuditService dedupe', () => {
  const viewing = {
    actor: AuditActor.Operator,
    action: AuditAction.CameraViewed,
    outcome: AuditOutcome.Allowed,
    dedupeKey: 'camera:lobby:operator',
  } as const;

  it('collapses a burst into one row', async () => {
    // Phase 1's auto-reconnect mints a fresh ticket per retry, so a flapping camera
    // would otherwise bury "who watched the lobby" under thousands of identical lines.
    const { service, create } = await buildService();

    for (let i = 0; i < 20; i += 1) await service.record({ ...viewing });

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps different cameras and different actors apart', async () => {
    const { service, create } = await buildService();

    await service.record({ ...viewing });
    await service.record({ ...viewing, dedupeKey: 'camera:garage:operator' });
    await service.record({ ...viewing, dedupeKey: 'camera:lobby:admin' });

    expect(create).toHaveBeenCalledTimes(3);
  });

  it('records again once the window has passed', async () => {
    const { service, create } = await buildService();
    await service.record({ ...viewing, dedupeWindowMs: 1_000 });

    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2_000);
    await service.record({ ...viewing, dedupeWindowMs: 1_000 });

    expect(create).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  });

  it('never dedupes an entry that did not ask for it', async () => {
    // Two identical mode changes are two separate facts, and losing one would be a
    // hole in the record rather than tidiness.
    const { service, create } = await buildService();

    await service.record({
      actor: AuditActor.Operator,
      action: AuditAction.ModeChanged,
      outcome: AuditOutcome.Allowed,
    });
    await service.record({
      actor: AuditActor.Operator,
      action: AuditAction.ModeChanged,
      outcome: AuditOutcome.Allowed,
    });

    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe('AuditService.findMany', () => {
  it('returns newest first, which is how an incident is read backwards', async () => {
    const { service, prisma } = await buildService();

    await service.findMany({});

    expect(prisma.auditLog.findMany.mock.calls[0][0].orderBy).toEqual({ at: 'desc' });
  });

  it('caps the page size regardless of what was asked for', async () => {
    const { service, prisma } = await buildService();

    await service.findMany({ limit: 100_000 });

    expect(prisma.auditLog.findMany.mock.calls[0][0].take).toBe(500);
  });

  it('filters to denials, the question worth asking', async () => {
    const { service, prisma } = await buildService();

    await service.findMany({ outcome: AuditOutcome.Denied });

    expect(prisma.auditLog.findMany.mock.calls[0][0].where).toEqual({
      outcome: AuditOutcome.Denied,
    });
  });
});

describe('audit permissions', () => {
  it('is admin-only', async () => {
    // Not because the contents are secret, but because a trail readable by the people
    // it records invites tidying.
    expect(ROLE_PERMISSIONS[AuthRole.Admin]).toContain(Permission.AuditRead);

    for (const role of [AuthRole.Operator, AuthRole.Viewer, AuthRole.Agent, AuthRole.Bootstrap]) {
      expect(ROLE_PERMISSIONS[role]).not.toContain(Permission.AuditRead);
    }
  });
});

describe('browser camera provisioning permission', () => {
  it('is admin-only', () => {
    // Minting a publishing credential is credential issuance. With shared per-role
    // secrets, giving this to operators means everyone holding the operator key can
    // create video sources that can show anything.
    expect(ROLE_PERMISSIONS[AuthRole.Admin]).toContain(Permission.CamerasProvision);

    for (const role of [AuthRole.Operator, AuthRole.Viewer, AuthRole.Agent, AuthRole.Bootstrap]) {
      expect(ROLE_PERMISSIONS[role]).not.toContain(Permission.CamerasProvision);
    }
  });

  it('does not give any human role the ability to publish frames directly', () => {
    // Minting a scoped agent token is the ONLY publishing path. If a human role held
    // CamerasPublish, the whole provisioning design would be bypassable.
    for (const role of [AuthRole.Admin, AuthRole.Operator, AuthRole.Viewer, AuthRole.Bootstrap]) {
      expect(ROLE_PERMISSIONS[role]).not.toContain(Permission.CamerasPublish);
    }
    expect(ROLE_PERMISSIONS[AuthRole.Agent]).toContain(Permission.CamerasPublish);
  });
});
