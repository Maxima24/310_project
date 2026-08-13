import type { AgentView } from '@cpe310/contracts';

import { Empty, Icon, Pill, type IconName } from './ui';
import { useUiStore } from '../stores/ui.store';

const TYPE_ICON: Record<string, IconName> = {
  motion: 'motion',
  door: 'door',
  camera: 'camera',
};

export function AgentGrid({ agents, loading }: { agents: AgentView[]; loading: boolean }) {
  const focusedAgentId = useUiStore((s) => s.focusedAgentId);
  const focusAgent = useUiStore((s) => s.focusAgent);

  if (loading) return <Empty icon="signal">Loading agents…</Empty>;
  if (agents.length === 0) return <Empty icon="signal">No agents registered yet.</Empty>;

  // Offline first: a silent sensor is the thing needing attention, and it is treated as
  // possible tampering rather than a harmless disconnect.
  const sorted = [...agents].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'offline' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  return (
    <ul className="agent-list">
      {sorted.map((agent) => {
        const focused = focusedAgentId === agent.id;

        return (
          <li key={agent.id}>
            <button
              type="button"
              className={[
                'agent',
                agent.status === 'offline' ? 'agent-offline' : '',
                focused ? 'agent-focused' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              // Filters the event and alert panels to this sensor; clicking again clears it.
              onClick={() => focusAgent(agent.id)}
              aria-pressed={focused}
              title={focused ? 'Clear filter' : 'Filter events and alerts to this agent'}
            >
              <span className="agent-icon">
                <Icon name={TYPE_ICON[agent.type] ?? 'signal'} size={17} />
              </span>

              <span className="agent-body">
                <span className="agent-name truncate">{agent.location}</span>
                <span className="agent-sub">
                  <span className="agent-id truncate">{agent.id}</span>
                </span>
                {agent.capabilities.length > 0 && (
                  <span className="caps">
                    {agent.capabilities.map((cap) => (
                      <span key={cap} className="cap">
                        {cap}
                      </span>
                    ))}
                  </span>
                )}
              </span>

              <span className="agent-right">
                <Pill tone={agent.status === 'online' ? 'ok' : 'critical'} dot>
                  {agent.status}
                </Pill>
                <span className="agent-seen">
                  {agent.status === 'offline'
                    ? `silent ${formatAge(agent.secondsSinceLastSeen)}`
                    : `${formatAge(agent.secondsSinceLastSeen)} ago`}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}
