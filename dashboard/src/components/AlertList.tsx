import type { AlertView } from '@cpe310/contracts';
import { useMemo, useState } from 'react';

import { AlertActivity } from './AlertActivity';
import { Button, Card, CountBadge, Empty, Icon, Status } from './ui';
import { ApiError } from '../lib/api';
import { clusterAlerts, type AlertCluster } from '../lib/cluster';
import { canAcknowledgeAlert, usePermissions } from '../lib/permissions';
import { useAcknowledge, useAcknowledgeMany, useAgents } from '../lib/queries';
import { useUiStore, type AlertFilter } from '../stores/ui.store';

const FILTERS: Array<{ value: AlertFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'critical', label: 'Critical' },
  { value: 'all', label: 'All' },
];

/** `info` maps to neutral: an informational alert is not an exception. */
const SEVERITY_TONE: Record<string, 'idle' | 'warn' | 'critical'> = {
  critical: 'critical',
  warning: 'warn',
  info: 'idle',
};

/**
 * Alerts.
 *
 * Rebuilt around a problem the first version had: after a few hours the panel was fifty
 * stacked rows, most of them the same sensor repeating, and the one thing needing a
 * human was somewhere in the middle. Three changes fix that structurally rather than
 * cosmetically:
 *
 *   1. An activity strip carries the history, so the list does not have to.
 *   2. Repeats collapse into one row with a count — twenty trips of one sensor is one
 *      situation, and one decision.
 *   3. Acknowledged clusters fold away behind a single line. They are recorded, not
 *      urgent, and keeping them expanded means the panel is mostly finished work.
 */
export function AlertList({
  alerts,
  totalCount,
  loading,
}: {
  alerts: AlertView[];
  totalCount: number;
  loading: boolean;
}) {
  const { identity, canAcknowledge } = usePermissions();
  const acknowledge = useAcknowledge();
  const acknowledgeMany = useAcknowledgeMany();
  const agents = useAgents();
  const alertFilter = useUiStore((s) => s.alertFilter);
  const setAlertFilter = useUiStore((s) => s.setAlertFilter);
  const [showHistory, setShowHistory] = useState(false);

  const clusters = useMemo(() => clusterAlerts(alerts), [alerts]);
  const active = clusters.filter((c) => !c.acknowledged);
  const history = clusters.filter((c) => c.acknowledged);

  // Alerts carry an agentId, not a location, so zone checks need the agent list.
  const locationOf = (agentId: string) => agents.data?.find((a) => a.id === agentId)?.location;

  const error = acknowledge.error ?? acknowledgeMany.error;
  const busy = acknowledge.isPending || acknowledgeMany.isPending;

  return (
    <Card
      title="Alerts"
      icon="bell"
      badge={<CountBadge>{totalCount}</CountBadge>}
      actions={
        <div className="filters" role="group" aria-label="Filter alerts">
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              className="filter"
              aria-pressed={filter.value === alertFilter}
              onClick={() => setAlertFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
      }
      flush
    >
      <AlertActivity alerts={alerts} />

      {error && (
        <p className="panel-error">
          {error instanceof ApiError ? error.message : 'Could not acknowledge that.'}
        </p>
      )}

      {loading ? (
        <Empty icon="bell">Loading alerts…</Empty>
      ) : clusters.length === 0 ? (
        <Empty icon={totalCount === 0 ? 'check' : 'bell'}>
          {totalCount === 0 ? 'Nothing to report.' : 'No alerts match this filter.'}
        </Empty>
      ) : (
        <>
          {active.length === 0 ? (
            <div className="all-clear">
              <Icon name="check" size={16} />
              <span>Nothing needs attention</span>
            </div>
          ) : (
            <ul className="alert-list card-scroll">
              {active.map((cluster) => (
                <ClusterRow
                  key={cluster.key}
                  cluster={cluster}
                  canAcknowledge={canAcknowledge}
                  busy={busy}
                  decisionFor={(alert) => canAcknowledgeAlert(identity, alert, locationOf)}
                  onAck={(ids) =>
                    ids.length === 1
                      ? acknowledge.mutate(cluster.latest)
                      : acknowledgeMany.mutate(ids)
                  }
                />
              ))}
            </ul>
          )}

          {history.length > 0 && (
            <div className="history">
              <button
                className="history-toggle"
                onClick={() => setShowHistory(!showHistory)}
                aria-expanded={showHistory}
              >
                <Icon name="chevron" size={14} className={showHistory ? 'rot' : ''} />
                {history.length} acknowledged
                <span className="dim">
                  · {history.reduce((sum, c) => sum + c.count, 0)} alerts
                </span>
              </button>

              {showHistory && (
                <ul className="alert-list card-scroll">
                  {history.map((cluster) => (
                    <ClusterRow
                      key={cluster.key}
                      cluster={cluster}
                      canAcknowledge={false}
                      busy={busy}
                      decisionFor={() => ({ allowed: false })}
                      onAck={() => undefined}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function ClusterRow({
  cluster,
  canAcknowledge,
  busy,
  decisionFor,
  onAck,
}: {
  cluster: AlertCluster;
  canAcknowledge: boolean;
  busy: boolean;
  decisionFor: (alert: AlertView) => { allowed: boolean; reason?: string };
  onAck: (ids: string[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { latest, count, severity, openIds } = cluster;
  const decision = decisionFor(latest);
  const repeated = count > 1;

  return (
    <li className={`alert alert-${severity} ${cluster.acknowledged ? 'alert-acked' : ''}`}>
      <div className="alert-main">
        <div className="alert-top">
          <Status tone={SEVERITY_TONE[severity] ?? 'idle'}>{severity}</Status>
          <span className="alert-type">{latest.type}</span>
          {repeated && (
            <button
              className="repeat"
              onClick={() => setExpanded(!expanded)}
              title={`${count} occurrences — show each`}
              aria-expanded={expanded}
            >
              ×{count}
            </button>
          )}
          <time className="alert-time" dateTime={latest.createdAt}>
            {formatTime(latest.createdAt)}
          </time>
        </div>

        <p className="alert-msg">{latest.message}</p>

        <p className="alert-meta">
          {/* The arm mode is why this alert exists at all — the same event would have
              been silent while disarmed. */}
          raised while <strong>{latest.modeAtTrigger}</strong>
          {latest.agentId && <> · {latest.agentId}</>}
          {repeated && <> · first {formatTime(cluster.firstAt)}</>}
        </p>

        {expanded && (
          <ol className="occurrences">
            {cluster.members.map((member) => (
              <li key={member.id}>
                <time dateTime={member.createdAt}>{formatTime(member.createdAt)}</time>
                <span className="dim">{member.acknowledged ? 'acked' : 'open'}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="alert-actions">
        {cluster.acknowledged ? (
          <span className="dim tiny">acked</span>
        ) : canAcknowledge ? (
          <Button
            size="sm"
            icon="check"
            disabled={!decision.allowed || busy}
            title={decision.allowed ? `Acknowledge ${openIds.length}` : decision.reason}
            onClick={() => onAck(openIds)}
          >
            {openIds.length > 1 ? `Ack ${openIds.length}` : 'Ack'}
          </Button>
        ) : (
          // Shown rather than omitted, so a viewer understands the alert is actionable
          // by someone — just not by them.
          <span className="dim tiny" title="Requires the operator role">
            operator
          </span>
        )}
      </div>
    </li>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
