import type { CameraStatusView } from '@cpe310/contracts';
import { useEffect, useState } from 'react';

import { api } from '../lib/api';
import { API_BASE } from '../lib/config';
import { usePermissions } from '../lib/permissions';
import { useCameras } from '../lib/queries';

/**
 * Live camera view.
 *
 * The stream is an `<img>` pointed at an MJPEG endpoint — the browser handles the
 * multipart response natively, so there is no player, no codec, and no WebSocket
 * plumbing. The cost is that `<img>` cannot send an Authorization header, which is why
 * the hub issues a short-lived single-use ticket instead of accepting the credential in
 * the URL.
 */
export function LiveView() {
  const { canReadAgents } = usePermissions();
  const cameras = useCameras(canReadAgents);
  const [watching, setWatching] = useState<string | null>(null);

  const list = cameras.data ?? [];

  if (!canReadAgents) return null;

  if (cameras.isPending) return <p className="muted">Loading cameras…</p>;

  if (list.length === 0) {
    return <p className="muted">No cameras in view.</p>;
  }

  return (
    <div className="camera-grid">
      {list.map((camera) => (
        <CameraTile
          key={camera.agentId}
          camera={camera}
          watching={watching === camera.agentId}
          onWatch={() => setWatching(watching === camera.agentId ? null : camera.agentId)}
        />
      ))}
    </div>
  );
}

function CameraTile({
  camera,
  watching,
  onWatch,
}: {
  camera: CameraStatusView;
  watching: boolean;
  onWatch: () => void;
}) {
  return (
    <figure className={`camera ${camera.streaming ? '' : 'camera-dark'}`}>
      <div className="camera-frame">
        {camera.streaming ? (
          watching ? (
            <CameraStream agentId={camera.agentId} />
          ) : (
            <button className="camera-play" onClick={onWatch}>
              <span className="camera-play-icon" aria-hidden="true">▶</span>
              Watch live
            </button>
          )
        ) : (
          <div className="camera-empty">
            <span className="camera-empty-mark" aria-hidden="true">◼</span>
            <span>No signal</span>
            {/* Says which of the several causes it is, rather than leaving the operator
                to guess between "camera off", "simulated", and "hub cannot see it". */}
            <span className="camera-empty-hint">
              Camera is simulated, stopped, or was started without <code>--stream</code>
            </span>
          </div>
        )}
      </div>

      <figcaption className="camera-meta">
        <span className="camera-name">{camera.location}</span>
        <span className="camera-id">{camera.agentId}</span>
        {camera.streaming ? (
          <span className="camera-live">
            <span className="camera-dot" aria-hidden="true"></span>
            live{camera.width ? ` · ${camera.width}×${camera.height}` : ''}
          </span>
        ) : (
          <span className="muted">offline</span>
        )}
        {watching && (
          <button className="link-button" onClick={onWatch}>
            Stop
          </button>
        )}
      </figcaption>
    </figure>
  );
}

/** Holds one MJPEG connection open for as long as it is mounted. */
function CameraStream({ agentId }: { agentId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    api
      .streamTicket(agentId)
      .then(({ ticket }) => {
        if (cancelled) return;
        // Built here rather than trusting the server's streamUrl verbatim, so the
        // dashboard's own API base (which differs in a split-origin deployment) applies.
        setSrc(`${API_BASE}/cameras/${agentId}/stream?ticket=${encodeURIComponent(ticket)}`);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not open the stream.');
      });

    return () => {
      cancelled = true;
      // Dropping the src closes the underlying connection. Without this the browser
      // keeps pulling frames from a hidden element, and the hub keeps a response open
      // for a viewer who has navigated away.
      setSrc(null);
    };
  }, [agentId]);

  if (error) return <div className="camera-empty">{error}</div>;
  if (!src) return <div className="camera-empty">Connecting…</div>;

  return (
    <img
      className="camera-img"
      src={src}
      alt={`Live view from ${agentId}`}
      onError={() => setError('The stream ended. Press Watch live to reconnect.')}
    />
  );
}
