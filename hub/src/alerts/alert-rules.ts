import {
  AlertSeverity,
  AlertType,
  EventType,
  SystemMode,
  type AgentType,
} from '@cpe310/contracts';

/**
 * Alert policy. Pure and I/O-free on purpose: the entire decision table is
 * unit-testable without a database, a clock, or a Nest container.
 *
 * Statefulness (dedup/cooldown, persistence, broadcast) lives in AlertsService.
 */

export interface RuleAgent {
  id: string;
  type: AgentType;
  location: string;
}

export interface RuleInput {
  eventType: EventType;
  mode: SystemMode;
  agent: RuleAgent;
}

export interface RuleOutcome {
  type: AlertType;
  severity: AlertSeverity;
  message: string;
}

/**
 * Sensor events -> alerts, as a function of arm mode.
 *
 * The `home` row is the interesting one: interior motion is suppressed because
 * occupants are expected to move, but doors still alert. That distinction is the
 * entire reason `home` exists as a separate mode from `disarmed`.
 *
 * agent_offline is NOT handled here — it originates from the liveness sweep
 * rather than an event, and it alerts in every mode. See offlineOutcome().
 */
export function evaluate({ eventType, mode, agent }: RuleInput): RuleOutcome | null {
  const where = `${agent.location} (${agent.id})`;

  switch (eventType) {
    case EventType.MotionDetected:
      if (mode !== SystemMode.Away) return null;
      return {
        type: AlertType.IntrusionMotion,
        severity: AlertSeverity.Critical,
        message: `Motion detected at ${where} while system was away`,
      };

    case EventType.CameraMotion:
      if (mode !== SystemMode.Away) return null;
      return {
        type: AlertType.CameraMotion,
        severity: AlertSeverity.Warning,
        message: `Camera motion at ${where} while system was away`,
      };

    case EventType.DoorOpened:
      if (mode === SystemMode.Disarmed) return null;
      return {
        type: AlertType.IntrusionDoor,
        severity:
          mode === SystemMode.Away ? AlertSeverity.Critical : AlertSeverity.Warning,
        message: `Door opened at ${where} while system was ${mode}`,
      };

    // A door closing is never an alert on its own — it is recorded so the event
    // log shows how long a door stood open.
    case EventType.DoorClosed:
      return null;

    default:
      // Unreachable while EventType is exhaustive; a new event type added to the
      // contracts without a rule here should be silent, not a crash.
      return null;
  }
}

/**
 * A sensor that stops reporting is treated as possible tamper, so this fires in
 * EVERY mode — including `disarmed`. Only the severity escalates with arm state:
 * a silent sensor while nobody is home is materially worse than one while the
 * system is off.
 */
export function offlineOutcome(agent: RuleAgent, mode: SystemMode, silentForMs: number): RuleOutcome {
  const seconds = Math.round(silentForMs / 1000);
  return {
    type: AlertType.AgentOffline,
    severity: mode === SystemMode.Disarmed ? AlertSeverity.Warning : AlertSeverity.Critical,
    // ASCII only: these strings land in Windows consoles (often a legacy
    // codepage) and, once roadmap item 3 lands, in SMS bodies.
    message:
      `${agent.type} agent at ${agent.location} (${agent.id}) stopped reporting ` +
      `${seconds}s ago - possible tamper`,
  };
}

/** Emitted when a previously-offline agent reports in, so the resolution is visible. */
export function recoveredOutcome(agent: RuleAgent): RuleOutcome {
  return {
    type: AlertType.AgentRecovered,
    severity: AlertSeverity.Info,
    message: `${agent.type} agent at ${agent.location} (${agent.id}) is reporting again`,
  };
}
