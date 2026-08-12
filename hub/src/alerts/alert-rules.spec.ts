import { AlertSeverity, AlertType, EventType, SystemMode } from '@cpe310/contracts';

import { evaluate, offlineOutcome, recoveredOutcome, type RuleAgent } from './alert-rules';

const motionAgent: RuleAgent = { id: 'motion-hallway', type: 'motion', location: 'Hallway' };
const doorAgent: RuleAgent = { id: 'door-front', type: 'door', location: 'Front door' };
const cameraAgent: RuleAgent = { id: 'camera-lobby', type: 'camera', location: 'Lobby' };

describe('alert rules', () => {
  /**
   * The full decision table. Kept as data rather than prose so a policy change is
   * a one-line diff and an accidental change is a loud failure.
   */
  const table: Array<{
    event: EventType;
    mode: SystemMode;
    agent: RuleAgent;
    expected: { type: AlertType; severity: AlertSeverity } | null;
  }> = [
    // Disarmed: sensors report, nothing alerts.
    { event: EventType.MotionDetected, mode: SystemMode.Disarmed, agent: motionAgent, expected: null },
    { event: EventType.DoorOpened, mode: SystemMode.Disarmed, agent: doorAgent, expected: null },
    { event: EventType.DoorClosed, mode: SystemMode.Disarmed, agent: doorAgent, expected: null },
    { event: EventType.CameraMotion, mode: SystemMode.Disarmed, agent: cameraAgent, expected: null },

    // Home: occupants move, so interior motion is expected — but doors are guarded.
    // This asymmetry is the entire reason `home` exists as a mode.
    { event: EventType.MotionDetected, mode: SystemMode.Home, agent: motionAgent, expected: null },
    { event: EventType.CameraMotion, mode: SystemMode.Home, agent: cameraAgent, expected: null },
    {
      event: EventType.DoorOpened,
      mode: SystemMode.Home,
      agent: doorAgent,
      expected: { type: AlertType.IntrusionDoor, severity: AlertSeverity.Warning },
    },
    { event: EventType.DoorClosed, mode: SystemMode.Home, agent: doorAgent, expected: null },

    // Away: nobody should be here, so any activity is an intrusion.
    {
      event: EventType.MotionDetected,
      mode: SystemMode.Away,
      agent: motionAgent,
      expected: { type: AlertType.IntrusionMotion, severity: AlertSeverity.Critical },
    },
    {
      event: EventType.DoorOpened,
      mode: SystemMode.Away,
      agent: doorAgent,
      expected: { type: AlertType.IntrusionDoor, severity: AlertSeverity.Critical },
    },
    {
      event: EventType.CameraMotion,
      mode: SystemMode.Away,
      agent: cameraAgent,
      expected: { type: AlertType.CameraMotion, severity: AlertSeverity.Warning },
    },
    { event: EventType.DoorClosed, mode: SystemMode.Away, agent: doorAgent, expected: null },
  ];

  // Title avoids `$expected.type`: Jest's interpolation cannot walk that path on
  // the rows where `expected` is null.
  it.each(table)(
    '$event in $mode',
    ({ event, mode, agent, expected }) => {
      const outcome = evaluate({ eventType: event, mode, agent });

      if (expected === null) {
        expect(outcome).toBeNull();
        return;
      }

      expect(outcome).not.toBeNull();
      expect(outcome?.type).toBe(expected.type);
      expect(outcome?.severity).toBe(expected.severity);
    },
  );

  it('covers every event type in every mode', () => {
    // Guards against a new EventType or SystemMode being added to the contracts
    // without a corresponding row above.
    const combinations = Object.values(EventType).length * Object.values(SystemMode).length;
    expect(table).toHaveLength(combinations);
  });

  it('names the location in the message so an alert is actionable without a lookup', () => {
    const outcome = evaluate({
      eventType: EventType.MotionDetected,
      mode: SystemMode.Away,
      agent: motionAgent,
    });

    expect(outcome?.message).toContain('Hallway');
    expect(outcome?.message).toContain('motion-hallway');
  });
});

describe('offlineOutcome', () => {
  // A silent sensor is treated as possible tamper, so this must fire even when the
  // system is off. Only the severity tracks arm state.
  it.each([
    [SystemMode.Disarmed, AlertSeverity.Warning],
    [SystemMode.Home, AlertSeverity.Critical],
    [SystemMode.Away, AlertSeverity.Critical],
  ])('alerts in %s mode with severity %s', (mode, severity) => {
    const outcome = offlineOutcome(motionAgent, mode, 32_000);

    expect(outcome.type).toBe(AlertType.AgentOffline);
    expect(outcome.severity).toBe(severity);
  });

  it('reports how long the agent has been silent and calls out tamper', () => {
    const outcome = offlineOutcome(doorAgent, SystemMode.Away, 32_400);

    expect(outcome.message).toContain('32s ago');
    expect(outcome.message).toContain('possible tamper');
  });
});

describe('recoveredOutcome', () => {
  it('is informational, not an alarm', () => {
    const outcome = recoveredOutcome(doorAgent);

    expect(outcome.type).toBe(AlertType.AgentRecovered);
    expect(outcome.severity).toBe(AlertSeverity.Info);
  });
});
