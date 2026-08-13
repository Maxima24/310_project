import type { AlertSeverity } from './alert';

/**
 * Outbound notification channels (roadmap item 3).
 *
 * The hub persists and broadcasts alerts already; these exist to reach a human who
 * is *not* watching a dashboard, which is the whole point of an alarm.
 */
export const NotificationChannel = {
  /** nodemailer over SMTP. */
  Email: 'email',
  /** POST the alert JSON to a URL — the escape hatch for Slack, PagerDuty, n8n. */
  Webhook: 'webhook',
  /** Writes to the hub log. Always available, and the fallback when nothing else is configured. */
  Log: 'log',
} as const;

export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const NotificationStatus = {
  Sent: 'sent',
  Failed: 'failed',
  /** Queued for retry after a transient failure. */
  Pending: 'pending',
  /** Suppressed because the alert's severity is below the channel's threshold. */
  Skipped: 'skipped',
} as const;

export type NotificationStatus = (typeof NotificationStatus)[keyof typeof NotificationStatus];

/** A delivery attempt, as the hub reports it. */
export interface NotificationView {
  id: string;
  alertId: string;
  channel: NotificationChannel;
  status: NotificationStatus;
  /** Attempts made so far; > 1 means an earlier try failed and was retried. */
  attempts: number;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

/**
 * Minimum severity a channel will deliver. Waking someone at 3am for an `info`
 * recovery notice is how an alarm gets ignored.
 */
export interface ChannelThreshold {
  channel: NotificationChannel;
  minSeverity: AlertSeverity;
}
