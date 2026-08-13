import type { AgentView } from '@cpe310/contracts';

import { useUiStore } from '../stores/ui.store';

const TYPE_ICON: Record<string, string> = {
  motion: '◉',
  door: '▭',
  camera: '▣',
};

export function AgentGrid({ agents, loading }: { agents: AgentView[]; loading: boolean }) {
  const focusedAgentId = useUiStore((s) => s.focusedAgentId);
  const focusAgent = useUiStore((s) => s.focusAgent);

  if (loading) return <p className="muted">Loading agents…</p>;
  if (agents.length === 0) return <p className="muted">No agents registered yet.</p>;

  // Offline first: a silent sensor is the thing needing attention, and it is treated as
  // possible tampering rather than a harmless disconnect.
  const sorted = [...agents].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'offline' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  return (
    <ul className="agent-grid">
      {sorted.map((agent) => (
        <li key={agent.id}>
          <button
            type="button"
            className={[
              'agent',
              `agent-${agent.status}`,
              focusedAgentId === agent.id ? 'agent-focused' : '',
            ]
              .join(' ')
              .trim()}
            // Filters the event stream and alert list to this sensor; clicking again clears it.
            onClick={() => focusAgent(agent.id)}
            title={
              focusedAgentId === agent.id ? 'Clear filter' : 'Filter events and alerts to this agent'
            }
          >
            <span className="agent-head">
              <span className="agent-icon" aria-hidden="true">
                {TYPE_ICON[agent.type] ?? '•'}
              </span>
              <span className="agent-id">{agent.id}</span>
              <span className={`dot dot-${agent.status}`} title={agent.status} />
            </span>

            <span className="agent-meta">
              <span>{agent.location}</span>
              <span className="muted">
                {agent.status === 'offline'
                  ? `silent ${formatAge(agent.secondsSinceLastSeen)}`
                  : `seen ${formatAge(agent.secondsSinceLastSeen)} ago`}
              </span>
            </span>

            {agent.capabilities.length > 0 && (
              <span className="agent-caps">
                {agent.capabilities.map((cap) => (
                  <span key={cap} className="cap">
                    {cap}
                  </span>
                ))}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}
