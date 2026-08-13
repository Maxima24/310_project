import type { AlertSeverity, AlertView, NotificationChannel } from '@cpe310/contracts';

/**
 * One outbound delivery route for an alert.
 *
 * Kept behind an interface so adding Twilio or FCM later is a new file plus a
 * provider registration — the dispatcher, retry logic, and persistence do not change.
 */
export interface AlertChannel {
  readonly name: NotificationChannel;

  /**
   * False when the channel has no usable configuration. Checked rather than throwing,
   * so an unconfigured channel is silently absent instead of generating a failed
   * delivery row for every alert.
   */
  isConfigured(): boolean;

  /** Minimum severity worth delivering on this route. */
  minSeverity(): AlertSeverity;

  /**
   * Deliver, or throw. Throwing marks the attempt for retry, so an implementation
   * must only throw on failures that could plausibly succeed later — a malformed
   * recipient should be logged and returned as success rather than retried forever.
   */
  send(alert: AlertView): Promise<void>;
}

/** Ranking used to compare an alert's severity against a channel's threshold. */
export const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export function meetsThreshold(severity: AlertSeverity, minimum: AlertSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minimum];
}
