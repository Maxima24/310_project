import { AuthRole, Permission, permissionsForRole } from '@cpe310/contracts';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { CredentialService, type Identity } from '../security/credential.service';
import { AuthGuard } from './auth.guard';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';

interface RequestShape {
  method: string;
  originalUrl: string;
  headers: Record<string, string | undefined>;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  identity?: Identity;
}

function identityFor(role: AuthRole, agentId?: string): Identity {
  return {
    role,
    permissions: permissionsForRole(role),
    zones: [],
    ...(agentId ? { agentId } : {}),
  };
}

function contextFor(request: RequestShape, type = 'http'): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function reflectorFor(metadata: { isPublic?: boolean; permissions?: Permission[] }): Reflector {
  return {
    getAllAndOverride: (key: string) => {
      if (key === IS_PUBLIC_KEY) return metadata.isPublic;
      if (key === PERMISSIONS_KEY) return metadata.permissions;
      return undefined;
    },
  } as unknown as Reflector;
}

function guardFor(
  identity: Identity | null,
  metadata: { isPublic?: boolean; permissions?: Permission[] } = {},
): AuthGuard {
  const credentials = {
    resolve: jest.fn().mockResolvedValue(identity),
  } as unknown as CredentialService;
  return new AuthGuard(credentials, reflectorFor(metadata));
}

const req = (over: Partial<RequestShape> = {}): RequestShape => ({
  method: 'POST',
  originalUrl: '/events',
  headers: { authorization: 'Bearer ag_token' },
  ...over,
});

describe('AuthGuard authentication', () => {
  it('lets a @Public route through with no credential at all', async () => {
    const guard = guardFor(null, { isPublic: true });

    await expect(guard.canActivate(contextFor(req({ headers: {} })))).resolves.toBe(true);
  });

  it('401s when the Authorization header is missing', async () => {
    const guard = guardFor(null, { permissions: [Permission.AlertsRead] });

    await expect(guard.canActivate(contextFor(req({ headers: {} })))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('401s on a credential the hub does not recognise', async () => {
    const guard = guardFor(null, { permissions: [Permission.AlertsRead] });

    await expect(guard.canActivate(contextFor(req()))).rejects.toThrow(UnauthorizedException);
  });

  it('ignores non-HTTP contexts, which the gateway authenticates itself', async () => {
    const guard = guardFor(null);

    await expect(guard.canActivate(contextFor(req(), 'ws'))).resolves.toBe(true);
  });

  it('attaches the resolved identity to the request', async () => {
    const request = req({ originalUrl: '/agents', params: {}, body: {} });
    const guard = guardFor(identityFor(AuthRole.Operator), {
      permissions: [Permission.AgentsRead],
    });

    await guard.canActivate(contextFor(request));

    expect(request.identity?.role).toBe(AuthRole.Operator);
  });
});

describe('AuthGuard permission enforcement', () => {
  it('denies a route that declares no permissions at all', async () => {
    // Fails closed: treating a missing decorator as "anyone authenticated" is how a
    // sensor token ends up able to disarm.
    const guard = guardFor(identityFor(AuthRole.Admin), {});

    await expect(guard.canActivate(contextFor(req()))).rejects.toThrow(ForbiddenException);
  });

  it('allows a caller holding the required permission', async () => {
    const guard = guardFor(identityFor(AuthRole.Viewer), {
      permissions: [Permission.AlertsRead],
    });

    await expect(guard.canActivate(contextFor(req({ body: {} })))).resolves.toBe(true);
  });

  it('requires ALL declared permissions, not any of them', async () => {
    const guard = guardFor(identityFor(AuthRole.Viewer), {
      permissions: [Permission.AlertsRead, Permission.AlertsAck],
    });

    await expect(guard.canActivate(contextFor(req()))).rejects.toThrow(/alerts:ack/);
  });

  it('names the missing permission and the role, so a 403 is diagnosable', async () => {
    const guard = guardFor(identityFor(AuthRole.Viewer), {
      permissions: [Permission.SystemDisarm],
    });

    await expect(guard.canActivate(contextFor(req()))).rejects.toThrow(
      /system:disarm.*"viewer"/s,
    );
  });
});

describe('AuthGuard role capabilities', () => {
  // The table that matters: what each role can actually reach. Derived from the shared
  // ROLE_PERMISSIONS map, so a change there shows up here rather than silently.
  const cases: Array<[AuthRole, Permission, boolean]> = [
    [AuthRole.Viewer, Permission.AlertsRead, true],
    [AuthRole.Viewer, Permission.AlertsAck, false],
    [AuthRole.Viewer, Permission.SystemArm, false],
    [AuthRole.Viewer, Permission.SystemDisarm, false],
    [AuthRole.Viewer, Permission.NotificationsRead, false],
    [AuthRole.Operator, Permission.AlertsAck, true],
    [AuthRole.Operator, Permission.SystemArm, true],
    [AuthRole.Operator, Permission.SystemDisarm, true],
    [AuthRole.Operator, Permission.NotificationsRead, false],
    [AuthRole.Admin, Permission.NotificationsRead, true],
    [AuthRole.Admin, Permission.SystemDisarm, true],
    // Agents and the bootstrap key hold no read permissions at all.
    [AuthRole.Agent, Permission.AlertsRead, false],
    [AuthRole.Agent, Permission.EventsWrite, true],
    [AuthRole.Agent, Permission.SystemDisarm, false],
    [AuthRole.Bootstrap, Permission.AgentsEnroll, true],
    [AuthRole.Bootstrap, Permission.AgentsRead, false],
    [AuthRole.Bootstrap, Permission.EventsWrite, false],
  ];

  it.each(cases)('%s %s -> %s', async (role, permission, allowed) => {
    const guard = guardFor(identityFor(role, 'motion-hallway'), { permissions: [permission] });
    const request = req({ params: {}, body: { agentId: 'motion-hallway' } });

    if (allowed) {
      await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    } else {
      await expect(guard.canActivate(contextFor(request))).rejects.toThrow(ForbiddenException);
    }
  });
});

describe('AuthGuard agent scoping', () => {
  const agentRoute = { permissions: [Permission.EventsWrite] };
  const agent = () => identityFor(AuthRole.Agent, 'motion-hallway');

  it('allows an agent to post an event as itself', async () => {
    const guard = guardFor(agent(), agentRoute);

    await expect(
      guard.canActivate(contextFor(req({ body: { agentId: 'motion-hallway' } }))),
    ).resolves.toBe(true);
  });

  it('blocks an agent from posting an event as a different sensor', async () => {
    // A compromised motion sensor must not be able to inject a `door_closed` for the
    // front door to mask an intrusion.
    const guard = guardFor(agent(), agentRoute);

    await expect(
      guard.canActivate(contextFor(req({ body: { agentId: 'door-front' } }))),
    ).rejects.toThrow(/cannot act as "door-front"/);
  });

  it('blocks an agent from faking a heartbeat for a sensor it disabled', async () => {
    const guard = guardFor(agent(), { permissions: [Permission.AgentsHeartbeat] });

    await expect(
      guard.canActivate(
        contextFor(
          req({ originalUrl: '/agents/door-front/heartbeat', params: { id: 'door-front' } }),
        ),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('prefers the path param over the body when both are present', async () => {
    const guard = guardFor(agent(), agentRoute);

    await expect(
      guard.canActivate(
        contextFor(req({ params: { id: 'door-front' }, body: { agentId: 'motion-hallway' } })),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a non-string agentId rather than coercing it', async () => {
    const guard = guardFor(agent(), agentRoute);

    await expect(
      guard.canActivate(
        contextFor(req({ body: { agentId: { toString: () => 'motion-hallway' } } })),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('does not apply self-scoping to human roles', async () => {
    // An operator acknowledging an alert has an :id in the path that is an alert id,
    // not an agent id — scoping must not fire on it.
    const guard = guardFor(identityFor(AuthRole.Operator), {
      permissions: [Permission.AlertsAck],
    });

    await expect(
      guard.canActivate(contextFor(req({ params: { id: 'some-alert-uuid' } }))),
    ).resolves.toBe(true);
  });
});
