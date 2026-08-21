import { AgentOrigin, MAX_CONCURRENT_STREAMS, type CameraStatusView } from '@cpe310/contracts';
import { useEffect, useRef } from 'react';

import { Empty, Icon, IconButton, Pill } from './ui';
import { api } from '../lib/api';
import { usePermissions } from '../lib/permissions';
import { useCameras } from '../lib/queries';
import { useCameraStream } from '../lib/useCameraStream';
import { useUiStore } from '../stores/ui.store';

/**
 * Live camera view.
 *
 * The stream is an `<img>` pointed at an MJPEG endpoint — the browser decodes the
 * multipart response natively, so there is no player, no codec, and no WebSocket
 * plumbing. Reconnection, backoff, and ticket minting all live in `useCameraStream`.
 *
 * Cameras that are live start on their own, up to MAX_CONCURRENT_STREAMS, because each
 * open stream holds a TCP connection for its whole life and browsers allow only about
 * six per origin. Which ones are watched is held in the UI store rather than here: as
 * component state it was thrown away on every unmount, so changing page dropped the
 * whole wall back to play buttons.
 *
 * ASSUMES ONE MOUNTED INSTANCE AT A TIME. Overview and Cameras are separate routes, so
 * that holds today; two at once would open two connections per camera and burn the
 * per-camera viewer cap.
 */
export function LiveView() {
  const { canViewCameras } = usePermissions();
  const cameras = useCameras(canViewCameras);

  const watch = useUiStore((s) => s.cameraWatch);
  const optOut = useUiStore((s) => s.cameraOptOut);
  const paused = useUiStore((s) => s.cameraPaused);
  const reconcile = useUiStore((s) => s.reconcileCameraWatch);
  const startWatching = useUiStore((s) => s.startWatchingCamera);
  const stopWatching = useUiStore((s) => s.stopWatchingCamera);
  const togglePaused = useUiStore((s) => s.toggleCameraPaused);
  const resumeAll = useUiStore((s) => s.resumeAllCameras);

  const list = cameras.data;

  // The auto-start. Runs on every poll result; the store returns its existing array
  // unchanged when nothing moved, so this does not churn the wall every 10 seconds.
  useEffect(() => {
    if (list) reconcile(list);
  }, [list, reconcile]);

  if (!canViewCameras) return null;
  if (cameras.isPending) return <Empty icon="camera">Loading cameras…</Empty>;

  const items = list ?? [];
  if (items.length === 0) return <Empty icon="camera">No cameras in view.</Empty>;

  const atCapacity = watch.length >= MAX_CONCURRENT_STREAMS;
  const hidden = items.filter((camera) => optOut.includes(camera.agentId)).length;

  return (
    <>
      {atCapacity && (
        <p className="camera-note">
          Watching {watch.length} of {MAX_CONCURRENT_STREAMS} — the browser allows only a
          handful of simultaneous streams, and more would stall the rest of the page.
        </p>
      )}

      {/* Stop is sticky by design, so without this an operator who stopped a tile last
          week has no way to discover why it never comes back. */}
      {hidden > 0 && (
        <p className="camera-note">
          {hidden} camera{hidden === 1 ? '' : 's'} stopped and will not start on their own.{' '}
          <button className="link-btn" onClick={resumeAll}>
            Resume all
          </button>
        </p>
      )}

      <div className="camera-grid">
        {items.map((camera) => (
          <CameraTile
            key={camera.agentId}
            camera={camera}
            watching={watch.includes(camera.agentId)}
            paused={paused.includes(camera.agentId)}
            blocked={atCapacity && !watch.includes(camera.agentId)}
            onStart={() => startWatching(camera.agentId)}
            onStop={() => stopWatching(camera.agentId)}
            onTogglePause={() => togglePaused(camera.agentId)}
          />
        ))}
      </div>
    </>
  );
}

function CameraTile({
  camera,
  watching,
  paused,
  blocked,
  onStart,
  onStop,
  onTogglePause,
}: {
  camera: CameraStatusView;
  watching: boolean;
  paused: boolean;
  blocked: boolean;
  onStart: () => void;
  onStop: () => void;
  onTogglePause: () => void;
}) {
  const figureRef = useRef<HTMLElement>(null);

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
      // The origin goes in the FILENAME too. A still saved from a browser feed and
      // produced months later must not be mistakable for device footage, and by then the
      // dashboard's badge is long gone.
      link.download = `${camera.agentId}-${camera.origin}-${new Date()
        .toISOString()
        .replace(/[:.]/g, '-')}.jpg`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      // A failed snapshot is not worth interrupting a live view for; the button simply
      // does nothing and the stream carries on.
    }
  };

  /**
   * OBSERVED FRAMES OUTRANK THE POLL.
   *
   * `camera.streaming` is a 10s poll of a flag with a 10s TTL, so it routinely lags
   * reality. Testing it before the stream state — as this used to — destroyed the
   * `<img>` of a tile that was visibly decoding frames, along with its controls, for a
   * whole poll cycle. A picture on screen is the better evidence, so it wins.
   */
  const showingPicture = Boolean(stream.src) && stream.state !== 'failed';
  const isBrowser = camera.origin === AgentOrigin.Browser;

  return (
    <figure ref={figureRef} className={`camera ${isBrowser ? 'camera-browser' : ''}`}>
      <div className="camera-frame">
        {/* ON THE FRAME, not only in the caption. Fullscreen shows the frame alone, and
            that is precisely when someone is looking hardest — a badge that disappears
            when the picture gets big is a badge that is absent when it matters. */}
        {isBrowser && showingPicture && (
          <span className="camera-origin-badge" title="Published from a browser, not a device">
            browser
          </span>
        )}
        {showingPicture ? (
          <img
            // Remount per attempt: the ticket in the src is single-use, so mutating the
            // src on an existing element can re-request a consumed URL and 403.
            key={stream.attemptKey}
            className="camera-img"
            src={stream.src!}
            alt={`Live view from ${camera.agentId}`}
            onError={stream.onImageError}
            onLoad={stream.onImageLoad}
          />
        ) : paused ? (
          <div className="camera-empty">
            <Icon name="play" size={24} />
            <span>Paused</span>
          </div>
        ) : stream.state === 'failed' ? (
          <div className="camera-empty">
            <Icon name="camera" size={24} />
            <span>Could not connect</span>
            {stream.error && <span className="camera-empty-hint">{stream.error}</span>}
            {/* Still retrying in the background — this only skips the wait. */}
            <button className="camera-play" onClick={stream.retry}>
              <Icon name="refresh" size={12} />
              Try again
            </button>
          </div>
        ) : stream.state === 'connecting' || stream.state === 'waiting' ? (
          <div className="camera-empty">
            <span className="spinner" />
            <span>{stream.state === 'waiting' ? 'Reconnecting…' : 'Connecting…'}</span>
          </div>
        ) : watching ? (
          // `standby` — the camera itself is sending nothing. The ONLY route to this
          // message, so it can no longer appear over a working feed.
          <div className="camera-empty">
            <Icon name="camera" size={24} />
            <span>No signal</span>
            <span className="camera-empty-hint">
              Simulated, stopped, or started without <span className="mono">--stream</span>
            </span>
          </div>
        ) : (
          <button className="camera-play" onClick={onStart} disabled={blocked}>
            <Icon name="play" size={12} />
            {blocked ? `Limit ${MAX_CONCURRENT_STREAMS} reached` : 'Watch live'}
          </button>
        )}

        {watching && (showingPicture || paused) && (
          <div className="camera-controls">
            <IconButton
              icon={paused ? 'play' : 'lock'}
              label={paused ? 'Resume' : 'Pause'}
              plain
              onClick={onTogglePause}
            />
            <IconButton icon="clip" label="Save a snapshot" plain onClick={() => void snapshot()} />
            <IconButton icon="chart" label="Fullscreen" plain onClick={fullscreen} />
          </div>
        )}
      </div>

      <figcaption className="camera-meta">
        <span className="camera-name truncate">{camera.location}</span>
        {isBrowser ? (
          <Pill tone="warn">browser</Pill>
        ) : (
          <span className="camera-id truncate">{camera.agentId}</span>
        )}

        {camera.streaming ? (
          <span className="camera-live" title={`${camera.viewers} viewer(s)`}>
            <span className="camera-dot" aria-hidden="true" />
            {/* The MEASURED rate, not the configured one — the gap between them is
                what makes a laggy feed diagnosable. */}
            {camera.fps !== null ? `${camera.fps} fps` : 'live'}
            {camera.width ? ` · ${camera.width}×${camera.height}` : ''}
          </span>
        ) : showingPicture ? (
          // Frames on screen, but the hub says the camera has gone quiet. Say so in the
          // caption rather than tearing down the picture: the last frame is still the
          // most recent thing anyone knows about that room.
          <span className="dim tiny" style={{ marginLeft: 'auto' }}>
            holding last frame
          </span>
        ) : (
          <span className="dim tiny" style={{ marginLeft: 'auto' }}>
            offline
          </span>
        )}

        {watching && (
          <button className="link-btn" onClick={onStop}>
            Stop
          </button>
        )}
      </figcaption>
    </figure>
  );
}
