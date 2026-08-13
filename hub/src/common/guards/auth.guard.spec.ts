import { AuthRole } from '@cpe310/contracts';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { CredentialService, type Identity } from '../security/credential.service';
import { AuthGuard } from './auth.guard';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';

interface RequestShape {
  method: string;
  originalUrl: string;
  headers: Record<string, string | undefined>;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  identity?: Identity;
}

function contextFor(request: RequestShape, type = 'http'): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** Reflector stub returning the metadata a route would carry. */
function reflectorFor(metadata: { isPublic?: boolean; roles?: AuthRole[] }): Reflector {
  return {
    getAllAndOverride: (key: string) => {
      if (key === IS_PUBLIC_KEY) return metadata.isPublic;
      if (key === ROLES_KEY) return metadata.roles;
      return undefined;
    },
  } as unknown as Reflector;
}

function guardFor(
  identity: Identity | null,
  metadata: { isPublic?: boolean; roles?: AuthRole[] } = {},
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

describe('AuthGuard credential handling', () => {
  it('lets a @Public route through with no credential at all', async () => {
    const guard = guardFor(null, { isPublic: true });

    await expect(guard.canActivate(contextFor(req({ headers: {} })))).resolves.toBe(true);
  });

  it('401s when the Authorization header is missing', async () => {
    const guard = guardFor(null);

    await expect(guard.canActivate(contextFor(req({ headers: {} })))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('401s on a credential the hub does not recognise', async () => {
    const guard = guardFor(null);

    await expect(guard.canActivate(contextFor(req()))).rejects.toThrow(UnauthorizedException);
  });

  it('ignores non-HTTP contexts, which the gateway authenticates itself', async () => {
    const guard = guardFor(null);

    await expect(guard.canActivate(contextFor(req(), 'ws'))).resolves.toBe(true);
  });

  it('attaches the resolved identity to the request', async () => {
    const request = req({ originalUrl: '/agents', params: {}, body: {} });
    const guard = guardFor({ role: AuthRole.Operator }, { roles: [AuthRole.Operator] });

    await guard.canActivate(contextFor(request));

    expect(request.identity).toEqual({ role: AuthRole.Operator });
  });
});

describe('AuthGuard role enforcement', () => {
  it('defaults to requiring operator when a route declares no roles', async () => {
    // A route added later must be locked down, not silently reachable by a sensor.
    const guard = guardFor({ role: AuthRole.Agent, agentId: 'motion-hallway' });

    await expect(guard.canActivate(contextFor(req()))).rejects.toThrow(ForbiddenException);
  });

  it('allows a matching role', async () => {
    const guard = guardFor({ role: AuthRole.Bootstrap }, { roles: [AuthRole.Bootstrap] });

    await expect(guard.canActivate(contextFor(req({ body: {} })))).resolves.toBe(true);
  });

  it.each([
    ['bootstrap key', AuthRole.Bootstrap],
    ['agent token', AuthRole.Agent],
  ])('403s when a %s is used on an operator-only route', async (_label, role) => {
    // Arming/disarming and acknowledging alerts must be unreachable from a sensor:
    // an intruder who compromised one could otherwise silence its own alert.
    const guard = guardFor({ role, agentId: 'motion-hallway' }, { roles: [AuthRole.Operator] });

    await expect(guard.canActivate(contextFor(req()))).rejects.toThrow(ForbiddenException);
  });

  it('403s when an operator key is used on an enrollment-only route', async () => {
    const guard = guardFor({ role: AuthRole.Operator }, { roles: [AuthRole.Bootstrap] });

    await expect(guard.canActivate(contextFor(req()))).rejects.toThrow(ForbiddenException);
  });
});

describe('AuthGuard agent scoping', () => {
  const agentIdentity: Identity = { role: AuthRole.Agent, agentId: 'motion-hallway' };
  const agentRoute = { roles: [AuthRole.Agent] };

  it('allows an agent to post an event as itself', async () => {
    const guard = guardFor(agentIdentity, agentRoute);
    const request = req({ body: { agentId: 'motion-hallway' } });

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
  });

  it('blocks an agent from posting an event as a different sensor', async () => {
    // The concrete win of roadmap 2: a compromised motion sensor cannot inject a
    // `door_closed` for the front door to mask an intrusion.
    const guard = guardFor(agentIdentity, agentRoute);
    const request = req({ body: { agentId: 'door-front' } });

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(
      /cannot act as "door-front"/,
    );
  });

  it('allows an agent to heartbeat for itself', async () => {
    const guard = guardFor(agentIdentity, agentRoute);
    const request = req({
      originalUrl: '/agents/motion-hallway/heartbeat',
      params: { id: 'motion-hallway' },
    });

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
  });

  it('blocks an agent from faking a heartbeat for a sensor it disabled', async () => {
    const guard = guardFor(agentIdentity, agentRoute);
    const request = req({
      originalUrl: '/agents/door-front/heartbeat',
      params: { id: 'door-front' },
    });

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(ForbiddenException);
  });

  it('prefers the path param over the body when both are present', async () => {
    const guard = guardFor(agentIdentity, agentRoute);
    const request = req({
      params: { id: 'door-front' },
      body: { agentId: 'motion-hallway' },
    });

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(ForbiddenException);
  });

  it('rejects a non-string agentId rather than coercing it', async () => {
    // `{"agentId": {...}}` must not slip past a loose equality check.
    const guard = guardFor(agentIdentity, agentRoute);
    const request = req({ body: { agentId: { toString: () => 'motion-hallway' } } });

    await expect(guard.canActivate(contextFor(request))).rejects.toThrow(ForbiddenException);
  });

  it('allows a request that claims no agent id at all', async () => {
    // Nothing to impersonate; DTO validation handles a genuinely missing field.
    const guard = guardFor(agentIdentity, agentRoute);

    await expect(guard.canActivate(contextFor(req({ body: {} })))).resolves.toBe(true);
  });
});
