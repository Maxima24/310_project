import { AuthRole, SystemMode, permissionsForRole } from '@cpe310/contracts';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import type { Identity } from './credential.service';
import { PolicyService } from './policy.service';

function identity(role: AuthRole, zones: string[] = []): Identity {
  return { role, permissions: permissionsForRole(role), zones };
}

async function buildService(openCriticalAlerts = 0, alertRow: unknown = null) {
  const prisma = {
    alert: {
      count: jest.fn().mockResolvedValue(openCriticalAlerts),
      findUnique: jest.fn().mockResolvedValue(alertRow),
    },
  };

  const moduleRef = await Test.createTestingModule({
    providers: [PolicyService, { provide: PrismaService, useValue: prisma }],
  }).compile();

  return { policy: moduleRef.get(PolicyService), prisma };
}

describe('PolicyService.canSetMode — arming', () => {
  it('lets an operator arm', async () => {
    const { policy } = await buildService();

    await expect(policy.canSetMode(identity(AuthRole.Operator), SystemMode.Away)).resolves.toEqual({
      allowed: true,
    });
  });

  it('refuses a viewer', async () => {
    const { policy } = await buildService();

    const decision = await policy.canSetMode(identity(AuthRole.Viewer), SystemMode.Away);

    expect(decision.allowed).toBe(false);
    expect(decision.requiresRole).toBe(AuthRole.Operator);
  });

  it('allows arming even with critical alerts open', async () => {
    // Refusing to let someone INCREASE protection during an incident would be the
    // wrong default; only disarming is restricted.
    const { policy } = await buildService(3);

    await expect(policy.canSetMode(identity(AuthRole.Operator), SystemMode.Away)).resolves.toEqual({
      allowed: true,
    });
  });

  it('does not query alerts when arming', async () => {
    const { policy, prisma } = await buildService();

    await policy.canSetMode(identity(AuthRole.Operator), SystemMode.Home);

    expect(prisma.alert.count).not.toHaveBeenCalled();
  });
});

describe('PolicyService.canSetMode — disarming with an active incident', () => {
  it('lets an operator disarm when nothing critical is open', async () => {
    const { policy } = await buildService(0);

    await expect(
      policy.canSetMode(identity(AuthRole.Operator), SystemMode.Disarmed),
    ).resolves.toEqual({ allowed: true });
  });

  it('blocks an operator from disarming while a critical alert is unacknowledged', async () => {
    // The failure mode: an intrusion alarm is sounding and the quickest way to silence
    // it is to disarm rather than investigate — which is what an intruder at the panel
    // would do.
    const { policy } = await buildService(2);

    const decision = await policy.canSetMode(identity(AuthRole.Operator), SystemMode.Disarmed);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/2 critical alerts still unacknowledged/);
    expect(decision.requiresRole).toBe(AuthRole.Admin);
  });

  it('pluralises a single alert correctly, since operators read this text', async () => {
    const { policy } = await buildService(1);

    const decision = await policy.canSetMode(identity(AuthRole.Operator), SystemMode.Disarmed);

    expect(decision.reason).toMatch(/1 critical alert still unacknowledged/);
  });

  it('tells the operator the way out rather than just refusing', async () => {
    const { policy } = await buildService(1);

    const decision = await policy.canSetMode(identity(AuthRole.Operator), SystemMode.Disarmed);

    expect(decision.reason).toMatch(/Acknowledge them first/);
  });

  it('lets an admin override', async () => {
    const { policy } = await buildService(5);

    await expect(policy.canSetMode(identity(AuthRole.Admin), SystemMode.Disarmed)).resolves.toEqual(
      { allowed: true },
    );
  });

  it('does not even query alerts for an admin', async () => {
    const { policy, prisma } = await buildService(5);

    await policy.canSetMode(identity(AuthRole.Admin), SystemMode.Disarmed);

    expect(prisma.alert.count).not.toHaveBeenCalled();
  });

  it('only counts unacknowledged critical alerts', async () => {
    const { policy, prisma } = await buildService(0);

    await policy.canSetMode(identity(AuthRole.Operator), SystemMode.Disarmed);

    expect(prisma.alert.count).toHaveBeenCalledWith({
      where: { severity: 'critical', acknowledged: false },
    });
  });
});

describe('PolicyService zone scoping', () => {
  it('allows any location when unrestricted', async () => {
    const { policy } = await buildService();

    expect(policy.canAccessLocation(identity(AuthRole.Operator), 'Anywhere').allowed).toBe(true);
  });

  it('allows a location inside the credential zones', async () => {
    const { policy } = await buildService();

    expect(
      policy.canAccessLocation(identity(AuthRole.Viewer, ['Hallway', 'Lobby']), 'Lobby').allowed,
    ).toBe(true);
  });

  it('matches zones case-insensitively', async () => {
    // Locations are free text typed by an operator; "lobby" and "Lobby" are the same room.
    const { policy } = await buildService();

    expect(
      policy.canAccessLocation(identity(AuthRole.Viewer, ['Lobby']), 'lobby').allowed,
    ).toBe(true);
  });

  it('refuses a location outside the zones and says which are allowed', async () => {
    const { policy } = await buildService();

    const decision = policy.canAccessLocation(identity(AuthRole.Viewer, ['Hallway']), 'Vault');

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/limited to: Hallway/);
  });

  it('reports no filter for an unrestricted identity', async () => {
    const { policy } = await buildService();

    expect(policy.zoneFilter(identity(AuthRole.Admin))).toBeNull();
  });

  it('reports the zone list for a restricted identity', async () => {
    const { policy } = await buildService();

    expect(policy.zoneFilter(identity(AuthRole.Viewer, ['Hallway']))).toEqual(['Hallway']);
  });
});

describe('PolicyService.canAcknowledgeAlert', () => {
  const alertIn = (location: string) => ({ agent: { location } });

  it('refuses a role without the permission', async () => {
    const { policy } = await buildService();

    const decision = await policy.canAcknowledgeAlert(identity(AuthRole.Viewer), 'alert-1');

    expect(decision.allowed).toBe(false);
    expect(decision.requiresRole).toBe(AuthRole.Operator);
  });

  it('allows an unrestricted operator without a lookup', async () => {
    const { policy, prisma } = await buildService();

    await expect(
      policy.canAcknowledgeAlert(identity(AuthRole.Operator), 'alert-1'),
    ).resolves.toEqual({ allowed: true });
    expect(prisma.alert.findUnique).not.toHaveBeenCalled();
  });

  it('allows a zoned operator to clear an alert in its own zone', async () => {
    const { policy } = await buildService(0, alertIn('Hallway'));

    const decision = await policy.canAcknowledgeAlert(
      identity(AuthRole.Operator, ['Hallway']),
      'alert-1',
    );

    expect(decision.allowed).toBe(true);
  });

  it('blocks a zoned operator from silencing another wing', async () => {
    const { policy } = await buildService(0, alertIn('Vault'));

    const decision = await policy.canAcknowledgeAlert(
      identity(AuthRole.Operator, ['Hallway']),
      'alert-1',
    );

    expect(decision.allowed).toBe(false);
  });

  it('blocks a zoned operator from clearing a system alert with no agent', async () => {
    // Conservative reading: an alert that cannot be attributed to their zone is not theirs.
    const { policy } = await buildService(0, { agent: null });

    const decision = await policy.canAcknowledgeAlert(
      identity(AuthRole.Operator, ['Hallway']),
      'alert-1',
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/not scoped to your zones/);
  });

  it('blocks acknowledgement of an alert that does not exist', async () => {
    const { policy } = await buildService(0, null);

    const decision = await policy.canAcknowledgeAlert(
      identity(AuthRole.Operator, ['Hallway']),
      'missing',
    );

    expect(decision.allowed).toBe(false);
  });
});
