import {
  AuthRole,
  Permission,
  ROLE_PERMISSIONS,
  SystemMode,
  type AlertView,
  type IdentityResponse,
} from '@cpe310/contracts';
import { describe, expect, it } from 'vitest';

import { canAcknowledgeAlert, evaluateModeChange } from './permissions';

function identity(role: AuthRole, zones: string[] = []): IdentityResponse {
  return { role, permissions: [...ROLE_PERMISSIONS[role]], zones };
}

function alert(overrides: Partial<AlertView> = {}): AlertView {
  return {
    id: 'a1',
    type: 'intrusion_motion',
    severity: 'critical',
    message: 'Motion while away',
    agentId: 'motion-hallway',
    modeAtTrigger: SystemMode.Away,
    acknowledged: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as AlertView;
}

describe('evaluateModeChange — arming', () => {
  it('lets an operator arm', () => {
    expect(evaluateModeChange(identity(AuthRole.Operator), SystemMode.Away, []).allowed).toBe(true);
  });

  it('lets an operator arm even during an open critical alert', () => {
    // Refusing to let someone RAISE protection during an incident would be the wrong
    // default — only lowering it is gated.
    const decision = evaluateModeChange(identity(AuthRole.Operator), SystemMode.Away, [alert()]);

    expect(decision.allowed).toBe(true);
  });

  it('refuses a viewer', () => {
    const decision = evaluateModeChange(identity(AuthRole.Viewer), SystemMode.Away, []);

    expect(decision.allowed).toBe(false);
    expect(decision.requiresRole).toBe(AuthRole.Operator);
  });
});

describe('evaluateModeChange — disarming', () => {
  it('lets an operator disarm when nothing is open', () => {
    expect(
      evaluateModeChange(identity(AuthRole.Operator), SystemMode.Disarmed, []).allowed,
    ).toBe(true);
  });

  it('refuses an operator while a critical alert is unacknowledged', () => {
    // The rule this whole system turns on: "make the alarm stop" is otherwise
    // indistinguishable from "investigate the alarm", and the former is what an
    // intruder at the panel would do.
    const decision = evaluateModeChange(identity(AuthRole.Operator), SystemMode.Disarmed, [
      alert(),
    ]);

    expect(decision.allowed).toBe(false);
    expect(decision.requiresRole).toBe(AuthRole.Admin);
    expect(decision.reason).toMatch(/unacknowledged/i);
  });

  it('allows it once the alert is acknowledged', () => {
    const decision = evaluateModeChange(identity(AuthRole.Operator), SystemMode.Disarmed, [
      alert({ acknowledged: true }),
    ]);

    expect(decision.allowed).toBe(true);
  });

  it('ignores non-critical alerts, however many', () => {
    const noisy = Array.from({ length: 20 }, (_, i) =>
      alert({ id: `w${i}`, severity: 'warning' }),
    );

    expect(
      evaluateModeChange(identity(AuthRole.Operator), SystemMode.Disarmed, noisy).allowed,
    ).toBe(true);
  });

  it('lets an admin override, because a named human takes responsibility', () => {
    const decision = evaluateModeChange(identity(AuthRole.Admin), SystemMode.Disarmed, [alert()]);

    expect(decision.allowed).toBe(true);
  });

  it('counts the blocking alerts in the reason, so the operator knows the size of it', () => {
    const decision = evaluateModeChange(identity(AuthRole.Operator), SystemMode.Disarmed, [
      alert({ id: 'a1' }),
      alert({ id: 'a2' }),
    ]);

    expect(decision.reason).toMatch(/2 critical alerts/);
  });

  it('refuses a viewer with a disarm-specific reason', () => {
    const decision = evaluateModeChange(identity(AuthRole.Viewer), SystemMode.Disarmed, []);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/cannot disarm/i);
  });
});

describe('canAcknowledgeAlert', () => {
  const locations: Record<string, string> = {
    'motion-hallway': 'north-wing',
    'door-front': 'lobby',
  };
  const locationOf = (agentId: string) => locations[agentId];

  it('refuses a credential without the permission', () => {
    const decision = canAcknowledgeAlert(identity(AuthRole.Viewer), alert(), locationOf);

    expect(decision.allowed).toBe(false);
    expect(decision.requiresRole).toBe(AuthRole.Operator);
  });

  it('allows an unrestricted operator', () => {
    expect(canAcknowledgeAlert(identity(AuthRole.Operator), alert(), locationOf).allowed).toBe(
      true,
    );
  });

  it('allows a zone-restricted operator inside their zone', () => {
    const decision = canAcknowledgeAlert(
      identity(AuthRole.Operator, ['north-wing']),
      alert(),
      locationOf,
    );

    expect(decision.allowed).toBe(true);
  });

  it('refuses one outside their zone', () => {
    // Otherwise an operator responsible for one wing could clear the whole building.
    const decision = canAcknowledgeAlert(
      identity(AuthRole.Operator, ['lobby']),
      alert(),
      locationOf,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/lobby/);
  });

  it('matches zones case-insensitively', () => {
    const decision = canAcknowledgeAlert(
      identity(AuthRole.Operator, ['North-Wing']),
      alert(),
      locationOf,
    );

    expect(decision.allowed).toBe(true);
  });

  it('errs toward ALLOWING when the location is unknown', () => {
    // Deliberate: the hub re-checks and can refuse with a real explanation. A rare 403
    // beats a button hidden because the agent list had not loaded yet.
    const decision = canAcknowledgeAlert(
      identity(AuthRole.Operator, ['lobby']),
      alert({ agentId: 'not-in-list' }),
      locationOf,
    );

    expect(decision.allowed).toBe(true);
  });
});

describe('role permission tables', () => {
  it('never gives an agent token a human capability', () => {
    // A compromised sensor must not be able to silence the alert its tampering raised.
    for (const permission of [
      Permission.AlertsAck,
      Permission.SystemDisarm,
      Permission.SystemArm,
      Permission.AuditRead,
      Permission.SchedulesWrite,
    ]) {
      expect(ROLE_PERMISSIONS[AuthRole.Agent]).not.toContain(permission);
    }
  });

  it('keeps the bootstrap key to enrolment and nothing else', () => {
    expect(ROLE_PERMISSIONS[AuthRole.Bootstrap]).toEqual([Permission.AgentsEnroll]);
  });

  it('gives a viewer no write capability at all', () => {
    const writes = [
      Permission.AlertsAck,
      Permission.SystemArm,
      Permission.SystemDisarm,
      Permission.SchedulesWrite,
      Permission.EventsWrite,
    ];

    for (const permission of writes) {
      expect(ROLE_PERMISSIONS[AuthRole.Viewer]).not.toContain(permission);
    }
  });

  it('makes admin a superset of operator', () => {
    for (const permission of ROLE_PERMISSIONS[AuthRole.Operator]) {
      expect(ROLE_PERMISSIONS[AuthRole.Admin]).toContain(permission);
    }
  });
});
