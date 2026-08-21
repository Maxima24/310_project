/**
 * Aggregated history for the Reports page.
 *
 * Reads from EventRollup where the hours have been counted and from raw Event for the
 * tail that has not, so the answer stays exact and does not double-count the overlap.
 * This is what the rollups are FOR: once a retention window is set, this page keeps
 * working on months whose raw rows are long gone.
 */

import type { AlertSeverity } from './alert';
import type { EventType } from './event';

export interface DailyActivity {
  /** YYYY-MM-DD in the requested time zone. */
  date: string;
  events: number;
  alerts: number;
}

export interface ReportsSummary {
  /** ISO start of the window. */
  since: string;
  days: number;
  /** The zone the day boundaries were computed in. */
  timezone: string;
  /**
   * Where counted history ends and raw rows take over, or null if nothing is rolled up
   * yet. Surfaced so the page can be honest about which half of a series is a summary.
   */
  rolledThrough: string | null;
  /** Oldest first, with empty days present rather than omitted. */
  daily: DailyActivity[];
  byAgent: Array<{ agentId: string; events: number }>;
  byType: Array<{ type: EventType; events: number }>;
  bySeverity: Array<{ severity: AlertSeverity; alerts: number }>;
  totals: { events: number; alerts: number; unacknowledged: number };
}

/** Windows the Reports page offers. Bounded because the query scans the window. */
export const REPORT_WINDOWS = [7, 30, 90] as const;
export type ReportWindow = (typeof REPORT_WINDOWS)[number];
