import type { AlertView } from '@cpe310/contracts';

import { ApiError } from '../lib/api';
import { canAcknowledgeAlert, usePermissions } from '../lib/permissions';
import { useAcknowledge, useAgents } from '../lib/queries';
import { useUiStore, type AlertFilter } from '../stores/ui.store';

const FILTERS: Array<{ value: AlertFilter; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'critical', label: 'Critical' },
  { value: 'all', label: 'All' },
];

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
    <>
      <h2>
        Alerts
        <span className="badge">{totalCount}</span>
        <div className="filter-group" role="group" aria-label="Alert filter">
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              className={filter.value === alertFilter ? 'chip chip-active' : 'chip'}
              onClick={() => setAlertFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </h2>

      {acknowledge.isError && (
        <p className="mode-error">
          {acknowledge.error instanceof ApiError
            ? acknowledge.error.message
            : 'Could not acknowledge that alert.'}
        </p>
      )}

      {loading ? (
        <p className="muted">Loading alerts…</p>
      ) : alerts.length === 0 ? (
        <p className="muted">
          {totalCount === 0 ? 'No alerts.' : 'No alerts match the current filter.'}
        </p>
      ) : (
        <ul className="alert-list">
          {alerts.map((alert) => {
            const decision = canAcknowledgeAlert(identity, alert, locationOf);

            return (
              <li
                key={alert.id}
                className={`alert alert-${alert.severity} ${alert.acknowledged ? 'alert-acked' : ''}`}
              >
                <div className="alert-main">
                  <div className="alert-line">
                    <span className={`sev sev-${alert.severity}`}>{alert.severity}</span>
                    <span className="alert-type">{alert.type}</span>
                    <time className="muted" dateTime={alert.createdAt}>
                      {new Date(alert.createdAt).toLocaleTimeString()}
                    </time>
                  </div>
                  <p className="alert-message">{alert.message}</p>
                  <p className="muted alert-context">
                    {/* The arm mode is why this alert exists at all — the same event
                        would have been silent while disarmed. */}
                    raised while <strong>{alert.modeAtTrigger}</strong>
                    {alert.agentId && <> · {alert.agentId}</>}
                  </p>
                </div>

                <div className="alert-actions">
                  {alert.acknowledged ? (
                    <span className="acked">acknowledged</span>
                  ) : canAcknowledge ? (
                    <button
                      className="ack-btn"
                      disabled={!decision.allowed || acknowledge.isPending}
                      title={decision.allowed ? undefined : decision.reason}
                      onClick={() => acknowledge.mutate(alert)}
                    >
                      Acknowledge
                    </button>
                  ) : (
                    // Shown rather than omitted, so a viewer understands the alert is
                    // actionable by someone — just not by them.
                    <span className="acked" title="Requires the operator role">
                      operator only
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
