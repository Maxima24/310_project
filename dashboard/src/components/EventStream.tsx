import type { EventView } from '@cpe310/contracts';

import { Empty, Icon, Pill, type Tone } from './ui';

/**
 * Live event log, with a link to video evidence when a camera attached one.
 */

/** Events that mean something happened get colour; the rest stay quiet. */
const EVENT_TONE: Record<string, Tone> = {
  motion_detected: 'warn',
  camera_motion: 'warn',
  door_opened: 'warn',
  door_closed: 'idle',
};

export function EventStream({ events, loading }: { events: EventView[]; loading: boolean }) {
  if (loading) return <Empty icon="chart">Loading events…</Empty>;
  if (events.length === 0) return <Empty icon="chart">Waiting for events…</Empty>;

  return (
    <ol className="events card-scroll">
      {events.map((event) => (
        <li key={event.id} className="event">
          <time className="event-time" dateTime={event.createdAt}>
            {new Date(event.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </time>

          <Pill tone={EVENT_TONE[event.type] ?? 'idle'}>{event.type.replace(/_/g, ' ')}</Pill>

          <span className="event-agent truncate">{event.agentId}</span>

          <span className="event-meta truncate">{summarise(event)}</span>

          <ClipLink event={event} />
        </li>
      ))}
    </ol>
  );
}

/** Renders the interesting metadata rather than dumping the whole object. */
function summarise(event: EventView): string {
  const meta = event.metadata as Record<string, unknown>;
  const parts: string[] = [];

  if (typeof meta.contour_area === 'number') parts.push(`${Math.round(meta.contour_area)}px`);
  if (typeof meta.source === 'string' && !['pir', 'reed_switch'].includes(meta.source)) {
    parts.push(meta.source.length > 26 ? `${meta.source.slice(0, 26)}…` : meta.source);
  }
  if (meta.initial === true) parts.push('at startup');

  return parts.join(' · ');
}

function ClipLink({ event }: { event: EventView }) {
  const meta = event.metadata as Record<string, unknown>;
  const url = typeof meta.clip_url === 'string' ? meta.clip_url : null;
  if (!url) return <span />;

  // The clip is referenced a beat before it exists — encode and upload happen off the
  // agent's poll loop — so the title explains a 404 rather than leaving it a mystery.
  const waitMs = typeof meta.clip_available_after_ms === 'number' ? meta.clip_available_after_ms : 0;

  return (
    <a
      className="clip-link"
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`Video evidence. Available ~${Math.ceil(waitMs / 1000)}s after the event; retry if not found yet.`}
    >
      <Icon name="clip" size={11} />
      clip
    </a>
  );
}
