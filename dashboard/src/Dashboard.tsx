import { useMemo } from 'react';

import { AgentGrid } from './components/AgentGrid';
import { AlertList } from './components/AlertList';
import { EventStream } from './components/EventStream';
import { LiveView } from './components/LiveView';
import { ModeControl } from './components/ModeControl';
import { TopBar } from './components/TopBar';
import { useHubSocket } from './lib/useHubSocket';
import { usePermissions } from './lib/permissions';
import { useAgents, useAlerts, useEvents, useMode } from './lib/queries';
import { useSessionStore } from './stores/session.store';
import { useUiStore } from './stores/ui.store';

export function Dashboard() {
  const credential = useSessionStore((s) => s.credential);
  const { canReadAgents, canReadEvents, canReadAlerts } = usePermissions();

  // The socket pushes into the same Query cache the hooks below read from.
  useHubSocket(credential, canReadAlerts);

  // Each query is skipped when the role cannot read it, so a viewer never fires a
  // request the hub would refuse.
  const agents = useAgents();
  const events = useEvents();
  const alerts = useAlerts();
  const mode = useMode();

  const alertFilter = useUiStore((s) => s.alertFilter);
  const focusedAgentId = useUiStore((s) => s.focusedAgentId);

  const allAlerts = alerts.data ?? [];

  const visibleAlerts = useMemo(() => {
    let list = allAlerts;
    if (alertFilter === 'open') list = list.filter((a) => !a.acknowledged);
    if (alertFilter === 'critical') list = list.filter((a) => a.severity === 'critical');
    if (focusedAgentId) list = list.filter((a) => a.agentId === focusedAgentId);
    return list;
  }, [allAlerts, alertFilter, focusedAgentId]);

  const visibleEvents = useMemo(() => {
    const list = events.data ?? [];
    return focusedAgentId ? list.filter((e) => e.agentId === focusedAgentId) : list;
  }, [events.data, focusedAgentId]);

  return (
    <div className="app">
      <TopBar />

      <ModeControl mode={mode.data ?? null} alerts={allAlerts} />

      <main className="panels">
        {canReadAlerts && (
          <section className="panel panel-wide">
            <AlertList alerts={visibleAlerts} totalCount={allAlerts.length} loading={alerts.isPending} />
          </section>
        )}

        {canReadAgents && (
          <section className="panel">
            <h2>
              Agents <span className="badge">{agents.data?.length ?? 0}</span>
            </h2>
            <AgentGrid agents={agents.data ?? []} loading={agents.isPending} />
          </section>
        )}

        {canReadAgents && (
          <section className="panel panel-wide">
            <h2>Live view</h2>
            <LiveView />
          </section>
        )}

        {canReadEvents && (
          <section className={canReadAgents ? 'panel panel-wide' : 'panel'}>
            <h2>
              Event stream
              {focusedAgentId && <span className="badge">filtered: {focusedAgentId}</span>}
            </h2>
            <EventStream events={visibleEvents} loading={events.isPending} />
          </section>
        )}
      </main>
    </div>
  );
}
