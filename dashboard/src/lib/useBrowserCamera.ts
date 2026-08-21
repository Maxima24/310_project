import {
  BROWSER_CAPTURE_DEFAULT_FPS,
  BROWSER_CAPTURE_HEIGHT,
  BROWSER_CAPTURE_JPEG_QUALITY,
  BROWSER_CAPTURE_MAX_FRAME_BYTES,
  BROWSER_CAPTURE_WIDTH,
} from '@cpe310/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, api } from './api';
import { nextBackoffMs } from './useCameraStream';
import { useCaptureStore } from '../stores/capture.store';
import { useSessionStore } from '../stores/session.store';

/**
 * Publishes this browser's webcam to the hub as a camera.
 *
 * Three things this file is careful about, each because the naive version is worse than
 * not having the feature:
 *
 * 1. **The tracks are always released.** If the camera indicator light stays on after
 *    someone presses Stop, a security product has failed at the one thing it is supposed
 *    to be trustworthy about. Every exit path stops every track.
 * 2. **It pauses when the tab is hidden rather than pretending to publish.** Browsers
 *    clamp timers in background tabs (Chrome's intensive throttling goes to roughly once
 *    a minute), so a naive loop silently drops to ~1fps while the operator believes a
 *    room is being watched. Saying "paused" is the honest option.
 * 3. **The loop is back-pressured, not interval-driven.** The next capture is scheduled
 *    only after the previous upload settles, so a slow hub lowers the frame rate instead
 *    of queueing uploads, and there is never more than one request in flight.
 */

export interface CaptureStats {
  /** Frames actually delivered per second over the last sample. */
  fps: number;
  /** Milliseconds spent turning a video frame into a JPEG. */
  encodeMs: number;
  /** Milliseconds spent uploading it. */
  uploadMs: number;
  /** Size of the most recent frame. */
  frameKb: number;
  /** What the camera is really producing, which may exceed what was requested. */
  sourceWidth: number;
  sourceHeight: number;
  /**
   * Whether the capture element is actually decoding.
   *
   * Reported because "publishing, zero frames" and "publishing fine" look identical from
   * the outside, and the difference is entirely in this one condition. Without it the
   * failure presents as a hang with nothing to read.
   */
  sourceReady: boolean;
}

const NO_STATS: CaptureStats = {
  fps: 0,
  encodeMs: 0,
  uploadMs: 0,
  frameKb: 0,
  sourceWidth: 0,
  sourceHeight: 0,
  sourceReady: false,
};

export type CaptureState =
  | 'unsupported'
  | 'idle'
  | 'starting'
  | 'publishing'
  | 'paused-hidden'
  | 'error';

export interface BrowserCameraController {
  state: CaptureState;
  error: string | null;
  devices: MediaDeviceInfo[];
  deviceId: string | null;
  /**
   * The capture source, owned by CaptureProvider and kept mounted app-wide.
   * Panels must NOT attach this — see `stream`.
   */
  videoRef: React.RefObject<HTMLVideoElement>;
  /**
   * The live MediaStream, for a preview elsewhere in the tree.
   *
   * A preview attaches THIS rather than reusing `videoRef`, because the capture element
   * has to outlive any panel showing it — several <video> elements can share one stream.
   */
  stream: MediaStream | null;
  /** Frames per second the operator asked for, bounded by what the hub allows. */
  fps: number;
  setFps: (fps: number) => void;
  /**
   * What the capture is ACTUALLY doing, sampled once a second.
   *
   * Exists for the same reason the hub reports measured fps rather than configured fps:
   * without it "the feed is slow" is an impression, and the three plausible causes —
   * encode, upload, and browser throttling — are indistinguishable.
   */
  stats: CaptureStats;
  framesSent: number;
  expiresAt: string | null;
  agentId: string | null;
  chooseDevice: (deviceId: string) => void;
  /** Prompts for permission and lists cameras with real labels. */
  enumerate: () => Promise<void>;
  start: (location: string, label?: string) => Promise<void>;
  stop: () => void;
}

/**
 * getUserMedia needs a secure context. `https://` and `http://localhost` qualify;
 * `http://<lan-ip>` — which is exactly how this stack is usually reached on a network —
 * does not. Detected so the panel can explain why instead of showing an empty picker.
 */
function isSupported(): boolean {
  return Boolean(
    typeof window !== 'undefined' &&
      window.isSecureContext &&
      navigator.mediaDevices?.getUserMedia,
  );
}

export function useBrowserCamera(): BrowserCameraController {
  const [state, setState] = useState<CaptureState>(() =>
    isSupported() ? 'idle' : 'unsupported',
  );
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [framesSent, setFramesSent] = useState(0);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [fps, setFps] = useState<number>(BROWSER_CAPTURE_DEFAULT_FPS);
  const [stats, setStats] = useState<CaptureStats>(NO_STATS);

  /**
   * Per-frame measurements accumulate in a ref and are published to state once a second.
   * Setting state per frame would re-render every consumer of the capture context ten
   * times a second to move a counter — the measurement would then be paying for itself.
   */
  const sample = useRef({ frames: 0, encodeMs: 0, uploadMs: 0, bytes: 0, since: Date.now() });

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const runRef = useRef(0);
  const failuresRef = useRef(0);
  const qualityRef = useRef(BROWSER_CAPTURE_JPEG_QUALITY);

  const session = useCaptureStore((s) => s.session);
  const setSession = useCaptureStore((s) => s.setSession);
  const deviceId = useCaptureStore((s) => s.deviceId);
  const setDeviceId = useCaptureStore((s) => s.setDeviceId);
  const sessionId = useSessionStore((s) => s.sessionId);

  /**
   * Releases the camera. Called from every exit path, and it must stay idempotent —
   * a double stop is far better than a missed one.
   */
  const releaseCamera = useCallback(() => {
    runRef.current += 1;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const stop = useCallback(() => {
    releaseCamera();
    const current = useCaptureStore.getState().session;
    if (current) {
      void api.revokeBrowserCamera(current.agentId).catch(() => {
        // The token expires on its own; a failed revoke is bounded, not permanent.
      });
    }
    setSession(null);
    setFramesSent(0);
    setState(isSupported() ? 'idle' : 'unsupported');
  }, [releaseCamera, setSession]);

  /**
   * Prompt once, THEN enumerate.
   *
   * `enumerateDevices()` returns entries with blank labels until permission has been
   * granted, so listing first would show "Camera 1, Camera 2" and force a guess. The
   * throwaway stream exists only to trigger the prompt and is stopped immediately.
   */
  const enumerate = useCallback(async () => {
    if (!isSupported()) {
      setState('unsupported');
      return;
    }

    try {
      const probe = await navigator.mediaDevices.getUserMedia({ video: true });
      probe.getTracks().forEach((track) => track.stop());

      const all = await navigator.mediaDevices.enumerateDevices();
      const cameras = all.filter((device) => device.kind === 'videoinput');
      setDevices(cameras);
      if (!deviceId && cameras[0]) setDeviceId(cameras[0].deviceId);
      setError(null);
    } catch (err) {
      setState('error');
      setError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Camera access was refused. Allow it in the browser’s site settings and try again.'
          : 'Could not list cameras on this device.',
      );
    }
  }, [deviceId, setDeviceId]);

  const start = useCallback(
    async (location: string, label?: string) => {
      if (!isSupported()) {
        setState('unsupported');
        return;
      }

      setState('starting');
      setError(null);
      setFramesSent(0);
      setStats(NO_STATS);
      sample.current = { frames: 0, encodeMs: 0, uploadMs: 0, bytes: 0, since: Date.now() };
      qualityRef.current = BROWSER_CAPTURE_JPEG_QUALITY;
      failuresRef.current = 0;

      // End any session already running before opening another. Without this, starting a
      // second time leaves the first agent registered but silent — it shows on the wall
      // as a permanently offline camera that nobody can account for.
      const previous = useCaptureStore.getState().session;
      if (previous) {
        releaseCamera();
        await api.revokeBrowserCamera(previous.agentId).catch(() => {});
        setSession(null);
      }

      try {
        // Constrain at the source rather than capturing 1080p and shrinking in JS, and
        // match the Python agent's defaults so both kinds of feed look alike.
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            width: { ideal: BROWSER_CAPTURE_WIDTH },
            height: { ideal: BROWSER_CAPTURE_HEIGHT },
            frameRate: { ideal: BROWSER_CAPTURE_DEFAULT_FPS },
          },
          audio: false,
        });

        streamRef.current = stream;
        setStream(stream);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {
            // Autoplay of a muted local preview is normally allowed; if it is not, the
            // capture still works because it reads from the element regardless.
          });
        }

        // The OS or the user revoked the device (unplugged, or another app took it).
        stream.getVideoTracks().forEach((track) => {
          track.onended = () => {
            setError('The camera was disconnected.');
            stop();
          };
        });

        const created = await api.createBrowserCamera({ location, label });
        setSession(created);
        setState('publishing');

        const run = ++runRef.current;
        void publishLoop(run, created.token, created.agentId, Math.min(fps, created.maxFps));
      } catch (err) {
        releaseCamera();
        setState('error');
        setError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error && err.name === 'NotAllowedError'
              ? 'Camera access was refused.'
              : 'Could not start publishing.',
        );
      }
    },
    // publishLoop is defined below and stable via refs; excluded deliberately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deviceId, fps, releaseCamera, setSession, stop],
  );

  /**
   * Grabs one frame and uploads it, then schedules the next.
   *
   * Self-scheduling rather than `setInterval`: with an interval, a hub that takes longer
   * than the period to answer accumulates overlapping uploads until the tab falls over.
   * Here the rate simply degrades.
   */
  const publishLoop = useCallback(
    async (run: number, token: string, agentId: string, maxFps: number) => {
      if (runRef.current !== run) return;

      const interval = 1000 / Math.max(1, maxFps);
      const startedAt = Date.now();

      const encodeStarted = performance.now();
      const blob = await captureFrame();
      const encodeMs = performance.now() - encodeStarted;

      if (runRef.current !== run) return;

      if (blob) {
        if (blob.size > BROWSER_CAPTURE_MAX_FRAME_BYTES) {
          // Drop it and back the quality off once, rather than uploading something the
          // hub will refuse on every attempt.
          qualityRef.current = Math.max(0.3, qualityRef.current - 0.2);
        } else {
          try {
            const uploadStarted = performance.now();
            await api.publishFrame(agentId, blob, token);
            const uploadMs = performance.now() - uploadStarted;

            if (runRef.current !== run) return;
            failuresRef.current = 0;

            sample.current.frames += 1;
            sample.current.encodeMs += encodeMs;
            sample.current.uploadMs += uploadMs;
            sample.current.bytes = blob.size;

          } catch (err) {
            if (runRef.current !== run) return;

            // 401/403 is a settled answer — the token expired or was revoked. Retrying
            // cannot help, and a loop of rejected uploads hides the real cause.
            if (err instanceof ApiError && (err.isAuthFailure || err.isForbidden)) {
              setError('The publishing session ended. Start it again to continue.');
              stop();
              return;
            }

            failuresRef.current += 1;
          }
        }
      }

      if (runRef.current !== run) return;

      // Published every cycle, NOT only after a successful upload. When the capture
      // element is not decoding there are no successful uploads at all, and that is
      // precisely the case the operator most needs described — reporting only on success
      // meant the one failure worth explaining showed nothing.
      const s = sample.current;
      const elapsed = Date.now() - s.since;
      if (elapsed >= 1000) {
        const video = videoRef.current;
        setStats({
          fps: Math.round((s.frames / elapsed) * 1000 * 10) / 10,
          encodeMs: s.frames ? Math.round(s.encodeMs / s.frames) : 0,
          uploadMs: s.frames ? Math.round(s.uploadMs / s.frames) : 0,
          frameKb: Math.round(s.bytes / 1024),
          sourceWidth: video?.videoWidth ?? 0,
          sourceHeight: video?.videoHeight ?? 0,
          sourceReady: Boolean(video && video.readyState >= 2 && video.videoWidth),
        });
        if (s.frames) setFramesSent((n) => n + s.frames);
        sample.current = { frames: 0, encodeMs: 0, uploadMs: 0, bytes: 0, since: Date.now() };
      }

      const delay =
        failuresRef.current > 0
          ? nextBackoffMs(failuresRef.current)
          : Math.max(0, interval - (Date.now() - startedAt));

      timerRef.current = window.setTimeout(
        () => void publishLoop(run, token, agentId, maxFps),
        delay,
      );
    },
    [stop],
  );

  /**
   * Draws the current video frame to a reused canvas and encodes it.
   *
   * DOWNSCALES TO BROWSER_CAPTURE_WIDTH. The getUserMedia constraint is only `ideal`,
   * which most webcams ignore — ask for 640 and a laptop camera hands you 1280x720 or
   * 1920x1080 anyway. Sizing the canvas to `video.videoWidth`, as this used to, meant
   * JPEG-encoding four to nine times the pixels every frame, and the encode is what the
   * capture rate is actually limited by once the network has headroom.
   *
   * The canvas is resized only when the target changes: assigning width or height resets
   * the drawing surface and reallocates its backing store even when the value is
   * identical, which at 10fps is a megabytes-per-second allocation for nothing.
   */
  const captureFrame = useCallback(async (): Promise<Blob | null> => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !video.videoWidth) return null;

    const scale = Math.min(1, BROWSER_CAPTURE_WIDTH / video.videoWidth);
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);

    const canvas = (canvasRef.current ??= document.createElement('canvas'));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, 0, 0, width, height);

    return new Promise((resolve) =>
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', qualityRef.current),
    );
  }, []);

  /**
   * Pause while hidden.
   *
   * Keeps the MediaStream — reacquiring it would re-prompt on some browsers — but stops
   * uploading, and says so. The alternative is a tile that reads "live" while receiving
   * a frame a minute.
   */
  useEffect(() => {
    const onVisibility = () => {
      const publishing = useCaptureStore.getState().session;
      if (!publishing) return;

      if (document.hidden) {
        runRef.current += 1;
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        setState('paused-hidden');
      } else {
        setState('publishing');
        const run = ++runRef.current;
        void publishLoop(run, publishing.token, publishing.agentId, publishing.maxFps);
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [publishLoop]);

  /**
   * The publishing session can never be more durable than the credential that minted it.
   * A sign-out — which bumps sessionId — ends it.
   */
  const firstSession = useRef(sessionId);
  useEffect(() => {
    if (sessionId === firstSession.current) return;
    if (useCaptureStore.getState().session) stop();
  }, [sessionId, stop]);

  /** Tab close. pagehide rather than beforeunload/unload, which are unreliable. */
  useEffect(() => {
    const onExit = () => {
      const publishing = useCaptureStore.getState().session;
      releaseCamera();
      if (publishing) api.revokeBrowserCameraOnExit(publishing.agentId);
    };

    window.addEventListener('pagehide', onExit);
    return () => window.removeEventListener('pagehide', onExit);
  }, [releaseCamera]);

  /**
   * Unmount releases the camera, so the light never stays on after the app is gone.
   *
   * This is exactly why the hook is mounted ONCE by CaptureProvider, above the router,
   * rather than by the panel that operates it. Mounted in the panel, closing the panel
   * tore down the capture while leaving the session registered — the wall then showed a
   * browser camera permanently "offline", and every restart orphaned another one.
   */
  useEffect(() => releaseCamera, [releaseCamera]);

  /**
   * Keeps the capture element bound to the live stream.
   *
   * start() binds it once, which is not enough on its own: if the element mounts after
   * that call, or React remounts it, the ref points at a fresh <video> with no source and
   * the capture silently yields nothing. Re-binding on change makes the attachment a
   * property of the state rather than of one moment in time.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    void video.play().catch(() => {
      // Muted playback is normally permitted; if it is refused the stats below report
      // the source as not ready rather than leaving it a mystery.
    });
  }, [stream]);

  /** A camera being plugged in or removed changes the list under the operator. */
  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return;
    const refresh = () => {
      void navigator.mediaDevices
        .enumerateDevices()
        .then((all) => setDevices(all.filter((d) => d.kind === 'videoinput')));
    };
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, []);

  return {
    state,
    error,
    devices,
    deviceId,
    videoRef,
    stream,
    fps,
    setFps,
    stats,
    framesSent,
    expiresAt: session?.expiresAt ?? null,
    agentId: session?.agentId ?? null,
    chooseDevice: setDeviceId,
    enumerate,
    start,
    stop,
  };
}
