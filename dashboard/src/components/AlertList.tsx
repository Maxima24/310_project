import type { AlertView } from '@cpe310/contracts';

import { Button, Card, CountBadge, Empty, Pill, type Tone } from './ui';
import { ApiError } from '../lib/api';
import { canAcknowledgeAlert, usePermissions } from '../lib/permissions';
import { useAcknowledge, useAgents } from '../lib/queries';
import { useUiStore, type AlertFilter } from '../stores/ui.store';

const FILTERS: Array<{ value: AlertFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'critical', label: 'Critical' },
  { value: 'all', label: 'All' },
];

const SEVERITY_TONE: Record<string, Tone> = {
  critical: 'critical',
  warning: 'warn',
  info: 'info',
};

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
  const agents = useAgents();
  const alertFilter = useUiStore((s) => s.alertFilter);
  const setAlertFilter = useUiStore((s) => s.setAlertFilter);

  // Alerts carry an agentId, not a location, so zone checks need the agent list.
  const locationOf = (agentId: string) => agents.data?.find((a) => a.id === agentId)?.location;

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
      {acknowledge.isError && (
        <p className="command-note command-note-error" style={{ padding: '0 16px 8px' }}>
          {acknowledge.error instanceof ApiError
            ? acknowledge.error.message
            : 'Could not acknowledge that alert.'}
        </p>
      )}

      {loading ? (
        <Empty icon="bell">Loading alerts…</Empty>
      ) : alerts.length === 0 ? (
        <Empty icon={totalCount === 0 ? 'check' : 'bell'}>
          {totalCount === 0 ? 'Nothing to report.' : 'No alerts match this filter.'}
        </Empty>
      ) : (
        <ul className="alert-list card-scroll">
          {alerts.map((alert) => {
            const decision = canAcknowledgeAlert(identity, alert, locationOf);

            return (
              <li
                key={alert.id}
                className={`alert alert-${alert.severity} ${alert.acknowledged ? 'alert-acked' : ''}`}
              >
                <div className="alert-main">
                  <div className="alert-top">
                    <Pill tone={SEVERITY_TONE[alert.severity] ?? 'idle'}>{alert.severity}</Pill>
                    <span className="alert-type">{alert.type}</span>
                    <time className="alert-time" dateTime={alert.createdAt}>
                      {new Date(alert.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </div>

                  <p className="alert-msg">{alert.message}</p>

                  <p className="alert-meta">
                    {/* The arm mode is why this alert exists at all — the same event
                        would have been silent while disarmed. */}
                    raised while <strong>{alert.modeAtTrigger}</strong>
                    {alert.agentId && <> · {alert.agentId}</>}
                  </p>
                </div>

                <div className="alert-actions">
                  {alert.acknowledged ? (
                    <span className="dim" style={{ fontSize: 'var(--text-xs)' }}>
                      acked
                    </span>
                  ) : canAcknowledge ? (
                    <Button
                      size="sm"
                      icon="check"
                      disabled={!decision.allowed || acknowledge.isPending}
                      title={decision.allowed ? 'Acknowledge' : decision.reason}
                      onClick={() => acknowledge.mutate(alert)}
                    >
                      Ack
                    </Button>
                  ) : (
                    // Shown rather than omitted, so a viewer understands the alert is
                    // actionable by someone — just not by them.
                    <span className="dim" style={{ fontSize: 'var(--text-xs)' }} title="Requires the operator role">
                      operator
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
