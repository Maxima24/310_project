import { SystemMode, type AlertView } from '@cpe310/contracts';
import { describe, expect, it } from 'vitest';

import { clusterAlerts } from './cluster';

let counter = 0;

function alert(overrides: Partial<AlertView> = {}): AlertView {
  counter += 1;
  return {
    id: `a${counter}`,
    type: 'intrusion_motion',
    severity: 'warning',
    message: 'Motion while away',
    agentId: 'motion-hallway',
    modeAtTrigger: SystemMode.Away,
    acknowledged: false,
    createdAt: new Date(Date.UTC(2026, 7, 14, 12, counter)).toISOString(),
    ...overrides,
  } as AlertView;
}

describe('clusterAlerts', () => {
  it('collapses repeats of the same problem into one row', () => {
    // Twenty near-identical alerts tell the reader nothing twenty times.
    const clusters = clusterAlerts(Array.from({ length: 20 }, () => alert()));

    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(20);
  });

  it('groups by type AND agent, not by message', () => {
    // agent_offline embeds a silence duration in its message, so grouping on message
    // would split one recurring problem into a list of singletons.
    const clusters = clusterAlerts([
      alert({ type: 'agent_offline', message: 'silent 31s' }),
      alert({ type: 'agent_offline', message: 'silent 94s' }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(2);
  });

  it('keeps different agents apart', () => {
    const clusters = clusterAlerts([alert({ agentId: 'a' }), alert({ agentId: 'b' })]);

    expect(clusters).toHaveLength(2);
  });

  it('keeps different types apart', () => {
    const clusters = clusterAlerts([
      alert({ type: 'intrusion_motion' }),
      alert({ type: 'intrusion_door' }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it('groups agentless alerts under one system key rather than dropping them', () => {
    const clusters = clusterAlerts([
      alert({ agentId: undefined }),
      alert({ agentId: undefined }),
    ]);

    expect(clusters).toHaveLength(1);
  });

  it('shows the newest member, since that is the current state of the problem', () => {
    const older = alert({ createdAt: '2026-08-14T10:00:00.000Z', message: 'first' });
    const newer = alert({ createdAt: '2026-08-14T11:00:00.000Z', message: 'latest' });

    const [cluster] = clusterAlerts([older, newer]);

    expect(cluster.latest.message).toBe('latest');
  });

  it('takes the WORST severity, because a cluster is as urgent as its worst member', () => {
    // Otherwise one critical hidden among nineteen warnings reads as a warning.
    const [cluster] = clusterAlerts([
      alert({ severity: 'warning' }),
      alert({ severity: 'critical' }),
      alert({ severity: 'info' }),
    ]);

    expect(cluster.severity).toBe('critical');
  });

  it('is acknowledged only when every member is', () => {
    const [partly] = clusterAlerts([
      alert({ acknowledged: true }),
      alert({ acknowledged: false }),
    ]);
    expect(partly.acknowledged).toBe(false);

    const [fully] = clusterAlerts([
      alert({ acknowledged: true }),
      alert({ acknowledged: true }),
    ]);
    expect(fully.acknowledged).toBe(true);
  });

  it('lists only the open members for a bulk acknowledge', () => {
    // Re-acknowledging a settled alert would be a pointless write and would move its
    // acknowledgedAt to now, rewriting when someone actually looked at it.
    const open = alert({ acknowledged: false });
    const [cluster] = clusterAlerts([open, alert({ acknowledged: true })]);

    expect(cluster.openIds).toEqual([open.id]);
  });

  it('spans first to last, so the duration of a problem is visible', () => {
    const [cluster] = clusterAlerts([
      alert({ createdAt: '2026-08-14T10:00:00.000Z' }),
      alert({ createdAt: '2026-08-14T12:00:00.000Z' }),
    ]);

    expect(cluster.firstAt).toBe('2026-08-14T10:00:00.000Z');
    expect(cluster.lastAt).toBe('2026-08-14T12:00:00.000Z');
  });

  it('returns nothing for an empty list rather than throwing', () => {
    expect(clusterAlerts([])).toEqual([]);
  });
});
