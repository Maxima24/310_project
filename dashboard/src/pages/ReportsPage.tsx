import { REPORT_WINDOWS, type DailyActivity } from '@cpe310/contracts';
import { useState } from 'react';

import { Card, Empty, Stat } from '../components/ui';
import { usePermissions } from '../lib/permissions';
import { useReports } from '../lib/queries';

/**
 * Aggregated history.
 *
 * Reads from the hourly rollups where they exist and raw rows for the tail, so this
 * page keeps working on windows whose individual events have been pruned. That is the
 * whole reason the rollup table exists.
 */
export function ReportsPage() {
  const { canReadEvents, canReadAlerts } = usePermissions();
  const [days, setDays] = useState<number>(30);
  const reports = useReports(days, canReadEvents && canReadAlerts);

  const data = reports.data;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Reports</h1>
        <div className="segmented" role="group" aria-label="Time window">
          {REPORT_WINDOWS.map((window) => (
            <button
              key={window}
              className={`segmented-item ${days === window ? 'is-active' : ''}`}
              aria-pressed={days === window}
              onClick={() => setDays(window)}
            >
              {window}d
            </button>
          ))}
        </div>
      </div>

      {reports.isPending && <Empty icon="chart">Loading history…</Empty>}

      {reports.isError && (
        <Empty icon="alert">
          {reports.error instanceof Error ? reports.error.message : 'Could not load reports.'}
        </Empty>
      )}

      {data && (
        <>
          <div className="stat-row">
            <Stat label="Events" icon="chart" value={data.totals.events} unit={`last ${days}d`} />
            <Stat label="Alerts" icon="bell" value={data.totals.alerts} unit={`last ${days}d`} />
            <Stat
              label="Still open"
              icon="alert"
              value={data.totals.unacknowledged}
              delta={data.totals.unacknowledged > 0 ? 'needs a human' : undefined}
              deltaTone="critical"
            />
            <Stat
              label="Busiest day"
              icon="signal"
              value={busiest(data.daily)?.events ?? 0}
              unit={busiest(data.daily)?.date ?? '—'}
            />
          </div>

          <Card title="Activity" icon="chart" actions={<span className="muted">{data.timezone}</span>}>
            <ActivityChart daily={data.daily} />
            {/* Said out loud because a summarised half and a raw half of the same line
                are not equally precise, and a chart that hides the difference invites
                conclusions the data does not support. */}
            <p className="field-hint" style={{ marginTop: 'var(--s3)' }}>
              {data.rolledThrough
                ? `Counted from hourly rollups through ${new Date(
                    data.rolledThrough,
                  ).toLocaleString()}, and from raw events after that. Both are exact.`
                : 'Counted from raw events. Hourly rollups begin at the next retention sweep.'}
            </p>
          </Card>

          <div className="grid-lower">
            <Card title="By agent" icon="signal" flush>
              <RankedList
                rows={data.byAgent.map((row) => ({ key: row.agentId, value: row.events }))}
                empty="No events in this window."
              />
            </Card>

            <Card title="By type" icon="chart" flush>
              <RankedList
                rows={data.byType.map((row) => ({
                  key: row.type.replace(/_/g, ' '),
                  value: row.events,
                }))}
                empty="No events in this window."
              />
            </Card>
          </div>

          <Card title="Alerts by severity" icon="bell" flush>
            <RankedList
              rows={data.bySeverity.map((row) => ({ key: row.severity, value: row.alerts }))}
              empty="No alerts in this window."
            />
          </Card>
        </>
      )}
    </>
  );
}

function busiest(daily: DailyActivity[]): DailyActivity | undefined {
  return daily.reduce<DailyActivity | undefined>(
    (best, day) => (!best || day.events > best.events ? day : best),
    undefined,
  );
}

/**
 * Daily events and alerts, drawn as bars.
 *
 * Hand-drawn rather than a charting library: this is one series pair over a bounded
 * window, and a dependency to draw rectangles would cost more than it explains. Alerts
 * are drawn as an overlay rather than a second chart because the question is always
 * "did activity turn into alerts", which two charts make you answer by eye.
 */
function ActivityChart({ daily }: { daily: DailyActivity[] }) {
  const peak = Math.max(1, ...daily.map((day) => day.events));

  if (daily.every((day) => day.events === 0 && day.alerts === 0)) {
    return <Empty icon="chart">Nothing recorded in this window.</Empty>;
  }

  return (
    <div className="chart" role="img" aria-label={`Daily activity across ${daily.length} days`}>
      {daily.map((day) => (
        <div
          className="chart-col"
          key={day.date}
          title={`${day.date} — ${day.events} event(s), ${day.alerts} alert(s)`}
        >
          <div className="chart-stack">
            <div
              className="chart-bar"
              style={{ height: `${Math.round((day.events / peak) * 100)}%` }}
            />
            {day.alerts > 0 && (
              <div
                className="chart-bar chart-bar-alert"
                style={{ height: `${Math.round((day.alerts / peak) * 100)}%` }}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function RankedList({
  rows,
  empty,
}: {
  rows: Array<{ key: string; value: number }>;
  empty: string;
}) {
  if (rows.length === 0) return <Empty icon="chart">{empty}</Empty>;
  const peak = Math.max(1, ...rows.map((row) => row.value));

  return (
    <ul className="ranked">
      {rows.map((row) => (
        <li className="ranked-row" key={row.key}>
          <span className="ranked-label">{row.key}</span>
          <span className="ranked-track">
            <span
              className="ranked-fill"
              style={{ width: `${Math.round((row.value / peak) * 100)}%` }}
            />
          </span>
          <span className="ranked-value">{row.value.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}
