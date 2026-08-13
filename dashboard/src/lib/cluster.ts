import type { AlertView } from '@cpe310/contracts';

/**
 * Collapses repeats into one row.
 *
 * A motion sensor tripping every few minutes for an hour produces twenty near-identical
 * alerts. Listed individually they bury everything else and tell the reader nothing
 * twenty times — the useful facts are "this sensor, this many times, most recently at".
 *
 * Grouping is by (type, agent) because that is what a human means by "the same alert".
 * Deliberately NOT by message: an agent_offline message embeds a silence duration, so
 * message-grouping would split one recurring problem into twenty singletons.
 */
export interface AlertCluster {
  key: string;
  /** Newest member — the one whose message and time are shown. */
  latest: AlertView;
  /** All members, newest first, for the expanded view. */
  members: AlertView[];
  count: number;
  /** Worst severity in the group; a cluster is as urgent as its worst member. */
  severity: AlertView['severity'];
  /** True only when every member has been acknowledged. */
  acknowledged: boolean;
  /** Members still needing a human, which is what a bulk acknowledge acts on. */
  openIds: string[];
  firstAt: string;
  lastAt: string;
}

const RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };

export function clusterAlerts(alerts: AlertView[]): AlertCluster[] {
  const groups = new Map<string, AlertView[]>();

  for (const alert of alerts) {
    const key = `${alert.type}::${alert.agentId ?? 'system'}`;
    const existing = groups.get(key);
    if (existing) existing.push(alert);
    else groups.set(key, [alert]);
  }

  const clusters: AlertCluster[] = [];

  for (const [key, members] of groups) {
    const sorted = [...members].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const worst = sorted.reduce((acc, alert) =>
      RANK[alert.severity] > RANK[acc.severity] ? alert : acc,
    );

    clusters.push({
      key,
      latest: sorted[0],
      members: sorted,
      count: sorted.length,
      severity: worst.severity,
      acknowledged: sorted.every((a) => a.acknowledged),
      openIds: sorted.filter((a) => !a.acknowledged).map((a) => a.id),
      firstAt: sorted[sorted.length - 1].createdAt,
      lastAt: sorted[0].createdAt,
    });
  }

  // Unacknowledged first, then by severity, then by recency — the order an operator
  // would triage in, rather than raw chronology.
  return clusters.sort((a, b) => {
    if (a.acknowledged !== b.acknowledged) return a.acknowledged ? 1 : -1;
    if (a.severity !== b.severity) return RANK[b.severity] - RANK[a.severity];
    return new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime();
  });
}
