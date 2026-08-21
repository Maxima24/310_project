import { useMemo } from 'react';

import { AgentGrid } from '../components/AgentGrid';
import { AlertList } from '../components/AlertList';
import { EventStream } from '../components/EventStream';
import { LiveView } from '../components/LiveView';
import { ModeControl } from '../components/ModeControl';
import { Banner, Card, CountBadge, Stat } from '../components/ui';
import { usePermissions } from '../lib/permissions';
import { useAgents, useAlerts, useEvents, useMode } from '../lib/queries';
import { useSessionStore } from '../stores/session.store';
import { useUiStore } from '../stores/ui.store';

export function Overview() {
  const connection = useSessionStore((s) => s.connection);
  const { canReadAgents, canReadEvents, canReadAlerts, canViewCameras, zones, isZoneRestricted } =
    usePermissions();

  const agents = useAgents();
  const events = useEvents();
  const alerts = useAlerts();
  const mode = useMode();

  const alertFilter = useUiStore((s) => s.alertFilter);
  const focusedAgentId = useUiStore((s) => s.focusedAgentId);

  const allAgents = agents.data ?? [];
  const allAlerts = alerts.data ?? [];
  const allEvents = events.data ?? [];

  const online = allAgents.filter((a) => a.status === 'online').length;
  const offline = allAgents.length - online;
  const unacknowledged = allAlerts.filter((a) => !a.acknowledged);
  const critical = unacknowledged.filter((a) => a.severity === 'critical');

  // "In the last hour" rather than a raw total: a lifetime count says nothing about
  // whether anything is happening right now, which is the only question at a glance.
  const recentEvents = useMemo(() => {
    const cutoff = Date.now() - 60 * 60_000;
    return allEvents.filter((e) => new Date(e.createdAt).getTime() > cutoff).length;
  }, [allEvents]);

  const visibleAlerts = useMemo(() => {
    let list = allAlerts;
    if (alertFilter === 'open') list = list.filter((a) => !a.acknowledged);
    if (alertFilter === 'critical') list = list.filter((a) => a.severity === 'critical');
    if (focusedAgentId) list = list.filter((a) => a.agentId === focusedAgentId);
    return list;
  }, [allAlerts, alertFilter, focusedAgentId]);

  const visibleEvents = useMemo(
    () => (focusedAgentId ? allEvents.filter((e) => e.agentId === focusedAgentId) : allEvents),
    [allEvents, focusedAgentId],
  );

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Overview</h1>
        {isZoneRestricted && (
          <span className="pill pill-brand" title="This credential is limited to specific zones">
            {zones.join(', ')}
          </span>
        )}
      </div>

      {connection === 'rejected' && (
        <Banner tone="critical">
          The hub refused this credential for the live feed. Everything below may be stale — sign
          out and re-enter it.
        </Banner>
      )}

      {isZoneRestricted && (
        <Banner tone="info" icon="shield">
          Zone-restricted credential. Agents, events, and alerts outside {zones.join(', ')} are
          filtered out by the hub, not merely hidden here.
        </Banner>
      )}

      <ModeControl mode={mode.data ?? null} alerts={allAlerts} />

      <div className="stat-row">
        {/* Deltas stay neutral unless something is genuinely wrong. The bar under
            "Agents" carries the healthy/offline split in shape, so it does not need
            to be repeated as a coloured word. */}
        {canReadAgents && (
          <Stat
            label="Agents"
            icon="signal"
            value={allAgents.length}
            delta={offline > 0 ? `${offline} offline` : `${online} online`}
            deltaTone={offline > 0 ? 'critical' : 'idle'}
            bar={[
              { value: online, tone: 'idle' },
              { value: offline, tone: 'critical' },
            ]}
          />
        )}
        {canReadAlerts && (
          <Stat
            label="Open alerts"
            icon="bell"
            value={unacknowledged.length}
            delta={`${allAlerts.length} total`}
          />
        )}
        {canReadAlerts && (
          <Stat
            label="Critical"
            icon="alert"
            value={critical.length}
            delta={critical.length > 0 ? 'action needed' : undefined}
            deltaTone="critical"
          />
        )}
        {canReadEvents && <Stat label="Events" icon="chart" value={recentEvents} unit="last hour" />}
        <Stat
          label="Arm state"
          icon="shield"
          value={<span style={{ textTransform: 'capitalize' }}>{mode.data?.mode ?? '—'}</span>}
          delta={mode.data?.mode === 'disarmed' ? 'not armed' : undefined}
          deltaTone="warn"
        />
      </div>

      <div className="grid-main">
        {canViewCameras && (
          <Card title="Live view" icon="camera" flush>
            <LiveView />
          </Card>
        )}

        {canReadAlerts && (
          <AlertList
            alerts={visibleAlerts}
            totalCount={allAlerts.length}
            loading={alerts.isPending}
          />
        )}
      </div>

      <div className="grid-lower">
        {canReadAgents && (
          <Card
            title="Agents"
            icon="signal"
            badge={<CountBadge>{allAgents.length}</CountBadge>}
            flush
          >
            <AgentGrid agents={allAgents} loading={agents.isPending} />
          </Card>
        )}

        {canReadEvents && (
          <Card
            title="Event stream"
            icon="chart"
            badge={
              focusedAgentId ? <CountBadge>filtered · {focusedAgentId}</CountBadge> : undefined
            }
            flush
          >
            <EventStream events={visibleEvents} loading={events.isPending} />
          </Card>
        )}
      </div>
    </>
  );
}
