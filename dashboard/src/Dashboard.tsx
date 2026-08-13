import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { AgentGrid } from './components/AgentGrid';
import { AlertList } from './components/AlertList';
import { EventStream } from './components/EventStream';
import { LiveView } from './components/LiveView';
import { ModeControl } from './components/ModeControl';
import { TopBar } from './components/TopBar';
import { Banner, Card, CountBadge, Stat } from './components/ui';
import { useHubSocket } from './lib/useHubSocket';
import { usePermissions } from './lib/permissions';
import { useAgents, useAlerts, useEvents, useMode } from './lib/queries';
import { useSessionStore } from './stores/session.store';
import { useUiStore } from './stores/ui.store';

export function Dashboard() {
  const credential = useSessionStore((s) => s.credential);
  const connection = useSessionStore((s) => s.connection);
  const { canReadAgents, canReadEvents, canReadAlerts, zones, isZoneRestricted } =
    usePermissions();
  const queryClient = useQueryClient();

  // The socket pushes into the same Query cache these hooks read from.
  useHubSocket(credential, canReadAlerts);

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
    <div className="shell">
      <TopBar onRefresh={() => void queryClient.invalidateQueries()} />

      <main className="page">
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
            The hub refused this credential for the live feed. Everything below may be stale —
            sign out and re-enter it.
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
          {canReadAgents && (
            <Stat
              label="Agents"
              icon="signal"
              value={allAgents.length}
              delta={offline > 0 ? `${offline} offline` : 'all online'}
              deltaTone={offline > 0 ? 'critical' : 'ok'}
              bar={[
                { value: online, tone: 'ok' },
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
              deltaTone="idle"
            />
          )}
          {canReadAlerts && (
            <Stat
              label="Critical"
              icon="alert"
              value={critical.length}
              delta={critical.length > 0 ? 'action needed' : 'clear'}
              deltaTone={critical.length > 0 ? 'critical' : 'ok'}
            />
          )}
          {canReadEvents && (
            <Stat label="Events" icon="chart" value={recentEvents} unit="last hour" />
          )}
          <Stat
            label="Arm state"
            icon="shield"
            value={<span style={{ textTransform: 'capitalize' }}>{mode.data?.mode ?? '—'}</span>}
            delta={mode.data?.mode === 'away' ? 'armed' : mode.data?.mode === 'home' ? 'partial' : 'off'}
            deltaTone={
              mode.data?.mode === 'away' ? 'critical' : mode.data?.mode === 'home' ? 'warn' : 'idle'
            }
          />
        </div>

        <div className="grid-main">
          {canReadAgents && (
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
            <Card title="Agents" icon="signal" badge={<CountBadge>{allAgents.length}</CountBadge>} flush>
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
      </main>
    </div>
  );
}
