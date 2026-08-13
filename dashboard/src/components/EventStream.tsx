import type { EventView } from '@cpe310/contracts';

/**
 * Live event log, including a link to video evidence when a camera attached one
 * (roadmap item 5).
 */
export function EventStream({ events, loading }: { events: EventView[]; loading: boolean }) {
  if (loading) return <p className="muted">Loading events…</p>;
  if (events.length === 0) {
    return <p className="muted">Waiting for events…</p>;
  }

  return (
    <ol className="event-stream">
      {events.map((event) => (
        <li key={event.id} className="event">
          <time className="event-time muted" dateTime={event.createdAt}>
            {new Date(event.createdAt).toLocaleTimeString()}
          </time>
          <span className={`event-type event-${event.type}`}>{event.type}</span>
          <span className="event-agent">{event.agentId}</span>
          <span className="event-meta muted">{summarise(event)}</span>
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

  if (typeof meta.contour_area === 'number') {
    parts.push(`${Math.round(meta.contour_area)}px`);
  }
  if (typeof meta.source === 'string' && meta.source !== 'pir' && meta.source !== 'reed_switch') {
    parts.push(String(meta.source));
  }
  if (meta.initial === true) parts.push('at startup');

  return parts.join(' · ');
}

function ClipLink({ event }: { event: EventView }) {
  const meta = event.metadata as Record<string, unknown>;
  const url = typeof meta.clip_url === 'string' ? meta.clip_url : null;
  if (!url) return null;

  // The clip is referenced slightly before it exists (encode + upload happen off the
  // agent's poll loop), so the title explains a 404 rather than leaving it a mystery.
  const waitMs =
    typeof meta.clip_available_after_ms === 'number' ? meta.clip_available_after_ms : 0;

  return (
    <a
      className="clip-link"
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`Video evidence. Available ~${Math.ceil(waitMs / 1000)}s after the event; retry if not found yet.`}
    >
      clip
    </a>
  );
}
