import { MAX_CONCURRENT_STREAMS, type CameraStatusView } from '@cpe310/contracts';
import { useRef, useState } from 'react';

import { Empty, Icon, IconButton } from './ui';
import { api } from '../lib/api';
import { API_BASE } from '../lib/config';
import { usePermissions } from '../lib/permissions';
import { useCameras } from '../lib/queries';
import { useCameraStream } from '../lib/useCameraStream';

/**
 * Live camera view.
 *
 * The stream is an `<img>` pointed at an MJPEG endpoint — the browser decodes the
 * multipart response natively, so there is no player, no codec, and no WebSocket
 * plumbing. Reconnection, backoff, and ticket minting all live in `useCameraStream`.
 *
 * Watching is opt-in per tile and capped, because each open stream holds a TCP socket
 * for its whole life and browsers allow only about six per origin.
 */
export function LiveView() {
  const { canReadAgents } = usePermissions();
  const cameras = useCameras(canReadAgents);
  const [watching, setWatching] = useState<string[]>([]);

  const list = cameras.data ?? [];

  if (!canReadAgents) return null;
  if (cameras.isPending) return <Empty icon="camera">Loading cameras…</Empty>;
  if (list.length === 0) return <Empty icon="camera">No cameras in view.</Empty>;

  const atCapacity = watching.length >= MAX_CONCURRENT_STREAMS;

  const toggle = (agentId: string) =>
    setWatching((current) =>
      current.includes(agentId)
        ? current.filter((id) => id !== agentId)
        : current.length >= MAX_CONCURRENT_STREAMS
          ? current
          : [...current, agentId],
    );

  return (
    <>
      {atCapacity && (
        <p className="camera-note">
          Watching {watching.length} of {MAX_CONCURRENT_STREAMS} — the browser allows only a
          handful of simultaneous streams, and more would stall the rest of the page.
        </p>
      )}

      <div className="camera-grid">
        {list.map((camera) => (
          <CameraTile
            key={camera.agentId}
            camera={camera}
            watching={watching.includes(camera.agentId)}
            blocked={atCapacity && !watching.includes(camera.agentId)}
            onToggle={() => toggle(camera.agentId)}
          />
        ))}
      </div>
    </>
  );
}

function CameraTile({
  camera,
  watching,
  blocked,
  onToggle,
}: {
  camera: CameraStatusView;
  watching: boolean;
  blocked: boolean;
  onToggle: () => void;
}) {
  const figureRef = useRef<HTMLElement>(null);
  const [paused, setPaused] = useState(false);

  const stream = useCameraStream({
    agentId: camera.agentId,
    enabled: watching && !paused,
    streaming: camera.streaming,
  });

  const fullscreen = () => void figureRef.current?.requestFullscreen?.();

  const snapshot = async () => {
    try {
      const blob = await api.snapshot(camera.agentId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${camera.agentId}-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      // A failed snapshot is not worth interrupting a live view for; the button simply
      // does nothing and the stream carries on.
    }
  };

  return (
    <figure ref={figureRef} className={`camera ${camera.streaming ? '' : 'camera-dark'}`}>
      <div className="camera-frame">
        {!camera.streaming ? (
          <div className="camera-empty">
            <Icon name="camera" size={24} />
            <span>No signal</span>
            <span className="camera-empty-hint">
              Simulated, stopped, or started without <span className="mono">--stream</span>
            </span>
          </div>
        ) : watching && stream.src ? (
          <img
            // Remount per attempt: the ticket in the src is single-use, so mutating the
            // src on an existing element can re-request a consumed URL and 403.
            key={stream.attemptKey}
            className="camera-img"
            src={stream.src}
            alt={`Live view from ${camera.agentId}`}
            onError={stream.onImageError}
            onLoad={stream.onImageLoad}
          />
        ) : watching ? (
          <div className="camera-empty">
            {stream.state === 'failed' ? (
              <>
                <Icon name="camera" size={24} />
                <span>Could not connect</span>
                {stream.error && <span className="camera-empty-hint">{stream.error}</span>}
                <button className="camera-play" onClick={stream.retry}>
                  <Icon name="refresh" size={12} />
                  Try again
                </button>
              </>
            ) : (
              <>
                <span className="spinner" />
                <span>{stream.state === 'waiting' ? 'Reconnecting…' : 'Connecting…'}</span>
              </>
            )}
          </div>
        ) : (
          <button className="camera-play" onClick={onToggle} disabled={blocked}>
            <Icon name="play" size={12} />
            {blocked ? `Limit ${MAX_CONCURRENT_STREAMS} reached` : 'Watch live'}
          </button>
        )}

        {watching && stream.state === 'playing' && (
          <div className="camera-controls">
            <IconButton
              icon={paused ? 'play' : 'lock'}
              label={paused ? 'Resume' : 'Pause'}
              plain
              onClick={() => setPaused(!paused)}
            />
            <IconButton icon="clip" label="Save a snapshot" plain onClick={() => void snapshot()} />
            <IconButton icon="chart" label="Fullscreen" plain onClick={fullscreen} />
          </div>
        )}
      </div>

      <figcaption className="camera-meta">
        <span className="camera-name truncate">{camera.location}</span>
        <span className="camera-id truncate">{camera.agentId}</span>

        {camera.streaming ? (
          <span className="camera-live" title={`${camera.viewers} viewer(s)`}>
            <span className="camera-dot" aria-hidden="true" />
            {/* The MEASURED rate, not the configured one — the gap between them is
                what makes a laggy feed diagnosable. */}
            {camera.fps !== null ? `${camera.fps} fps` : 'live'}
            {camera.width ? ` · ${camera.width}×${camera.height}` : ''}
          </span>
        ) : (
          <span className="dim tiny" style={{ marginLeft: 'auto' }}>
            offline
          </span>
        )}

        {watching && (
          <button className="link-btn" onClick={onToggle}>
            Stop
          </button>
        )}
      </figcaption>
    </figure>
  );
}
