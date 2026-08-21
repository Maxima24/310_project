import {
  BROWSER_CAPTURE_FPS_CHOICES,
  BROWSER_CAPTURE_WIDTH,
  MAX_BROWSER_CAMERAS,
} from '@cpe310/contracts';
import { useEffect, useRef, useState } from 'react';

import { Banner, Button, Icon, Pill } from './ui';
import { useCapture } from '../lib/CaptureProvider';
import { useUiStore } from '../stores/ui.store';

/**
 * Publishes this browser's own camera to the hub.
 *
 * The copy here carries a load the controls cannot: a browser feed is the one camera
 * source an operator can fabricate, so the panel says what it is for and what it is not,
 * rather than presenting itself as equivalent to a device.
 */
export function BrowserCameraPanel({ onClose }: { onClose: () => void }) {
  // Shared with the whole app, so closing this panel does not stop the feed.
  const camera = useCapture();
  const [location, setLocation] = useState('');
  const [label, setLabel] = useState('');
  const startWatching = useUiStore((s) => s.startWatchingCamera);
  const previewRef = useRef<HTMLVideoElement>(null);

  // The preview is a SECOND element on the same stream; the element frames are captured
  // from lives in CaptureProvider and must not be borrowed here.
  useEffect(() => {
    const video = previewRef.current;
    if (!video) return;
    video.srcObject = camera.stream;
    if (camera.stream) void video.play().catch(() => {});
  }, [camera.stream]);

  // Prompt and list on open: an empty picker with no explanation is the worst first
  // impression this panel could make.
  useEffect(() => {
    if (camera.state === 'idle' && camera.devices.length === 0) void camera.enumerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.state]);

  const publishing = camera.state === 'publishing' || camera.state === 'paused-hidden';

  if (camera.state === 'unsupported') {
    return (
      <div className="wizard">
        <div className="wizard-head">
          <h3 className="wizard-title">
            <Icon name="camera" size={15} />
            Use this browser's camera
          </h3>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        {/* Explained rather than left as an empty list, because the cause is not obvious
            and the fix is a deployment change, not a browser setting. */}
        <Banner tone="critical" icon="alert">
          Browsers only grant camera access on a secure origin. This page is served over
          plain HTTP from something other than <span className="mono">localhost</span>, so
          the camera cannot be reached. Open the dashboard at{' '}
          <span className="mono">localhost</span>, or give the deployment a hostname so
          Caddy provisions HTTPS.
        </Banner>
      </div>
    );
  }

  return (
    <div className="wizard">
      <div className="wizard-head">
        <h3 className="wizard-title">
          <Icon name="camera" size={15} />
          Use this browser's camera
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      <Banner tone="info" icon="shield">
        Frames are published while <strong>this tab stays open</strong> — good for testing
        and for a spare laptop, not a substitute for a dedicated device. Every feed from a
        browser is marked <Pill tone="warn">browser</Pill> wherever it appears, because
        unlike a device it can show anything, and nobody reviewing footage later should
        have to guess which it was. At most {MAX_BROWSER_CAMERAS} can exist at once.
      </Banner>

      <div className="capture-layout">
        <div className="capture-preview">
          {/* Muted and playsInline so the local preview never makes noise or goes
              fullscreen on mobile. */}
          <video ref={previewRef} muted playsInline className="capture-video" />
          {camera.state === 'paused-hidden' && (
            <div className="capture-overlay">
              <Icon name="play" size={22} />
              <span>Paused — this tab is in the background</span>
            </div>
          )}
        </div>

        <div className="capture-controls">
          <div className="field">
            <label className="label" htmlFor="capture-device">
              Camera
            </label>
            <select
              id="capture-device"
              className="input"
              value={camera.deviceId ?? ''}
              onChange={(e) => camera.chooseDevice(e.target.value)}
              disabled={publishing}
            >
              {camera.devices.length === 0 && <option value="">No cameras found</option>}
              {camera.devices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${index + 1}`}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="label" htmlFor="capture-location">
              Where is it pointing?
            </label>
            <input
              id="capture-location"
              className="input"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Front Office"
              disabled={publishing}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="capture-label">
              Note <span className="label-optional">optional</span>
            </label>
            <input
              id="capture-label"
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Ada's laptop"
              disabled={publishing}
            />
          </div>

          <div className="field">
            <span className="label">Frame rate</span>
            <div className="segmented" role="group" aria-label="Frame rate">
              {BROWSER_CAPTURE_FPS_CHOICES.map((choice) => (
                <button
                  key={choice}
                  className={`segmented-item ${camera.fps === choice ? 'is-active' : ''}`}
                  aria-pressed={camera.fps === choice}
                  disabled={publishing}
                  onClick={() => camera.setFps(choice)}
                >
                  {choice} fps
                </button>
              ))}
            </div>
            {/* Said because the number is not free: each frame is a separate upload, and
                the loop waits for one to finish before starting the next. */}
            <p className="field-hint">
              Higher is smoother but uses more upload and more of this machine. 10 looks
              natural; 15 is worth it only on a fast local network.
            </p>
          </div>

          {camera.error && <p className="form-error">{camera.error}</p>}

          {publishing ? (
            <>
              {/* Measured, not configured. Without the breakdown, a slow feed has three
                  indistinguishable causes — encode, upload, and browser throttling — and
                  every guess about which costs an afternoon. */}
              <div className="capture-stats">
                <span>
                  <strong>{camera.stats.fps || '—'}</strong> fps actual
                </span>
                <span className="dim">encode {camera.stats.encodeMs}ms</span>
                <span className="dim">upload {camera.stats.uploadMs}ms</span>
                <span className="dim">{camera.stats.frameKb} kB/frame</span>
              </div>
              <div className="capture-stats">
                <span className="dim">
                  camera gives {camera.stats.sourceWidth}×{camera.stats.sourceHeight}, sent at{' '}
                  {Math.min(BROWSER_CAPTURE_WIDTH, camera.stats.sourceWidth || 0)} wide
                </span>
              </div>

              {/* The one failure that otherwise presents as a hang: the session is open,
                  the panel says publishing, and no frame ever leaves because the capture
                  source is not decoding. Named, rather than left to be inferred. */}
              {camera.state === 'publishing' && !camera.stats.sourceReady && (
                <Banner tone="critical" icon="alert">
                  The camera is connected but not producing frames yet, so nothing is being
                  published. If this persists, stop and start again — and if it still happens,
                  another application may be holding the camera.
                </Banner>
              )}
              <div className="capture-stats">
                <span className="dim">
                  <span className="mono">{camera.agentId}</span>
                </span>
                {camera.expiresAt && (
                  <span className="dim">
                    session ends {new Date(camera.expiresAt).toLocaleTimeString()}
                  </span>
                )}
              </div>
              <div className="wizard-step-actions">
                <Button
                  onClick={() => {
                    if (camera.agentId) startWatching(camera.agentId);
                    onClose();
                  }}
                >
                  See it on the wall
                </Button>
                {/* The control that turns the camera light off. It stops the tracks and
                    revokes the token, in that order. */}
                <Button variant="primary" icon="lock" onClick={camera.stop}>
                  Stop publishing
                </Button>
              </div>
            </>
          ) : (
            <Button
              variant="primary"
              disabled={
                camera.state === 'starting' ||
                !location.trim() ||
                camera.devices.length === 0
              }
              onClick={() => void camera.start(location.trim(), label.trim() || undefined)}
            >
              {camera.state === 'starting' ? 'Starting…' : `Start publishing at ${camera.fps} fps`}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
