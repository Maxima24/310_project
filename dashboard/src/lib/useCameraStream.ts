import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from './api';
import { API_BASE } from './config';

/**
 * Owns one camera's MJPEG connection: ticket minting, reconnection, and backoff.
 *
 * The failure this exists to fix: a stream that dropped needed a manual click, because
 * `<img>.onerror` was a dead end and the single-use ticket in the URL had already been
 * consumed — so reloading the same src could only ever produce a 403.
 */

/** Concurrent ticket mints across the whole page. */
const MINT_CONCURRENCY = 2;

/** Attempts before the tile gives up and offers a manual retry. */
const MAX_ATTEMPTS = 6;

/** A stream up for at least this long is considered healthy, resetting the backoff. */
const HEALTHY_AFTER_MS = 10_000;

/**
 * Full jitter over the top half of the window.
 *
 * Tiles that drop together — which is exactly what a hub restart causes — must not
 * retry together, or the hub gets a synchronised burst of ticket mints at the moment
 * it is least able to serve them.
 */
export function nextBackoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/**
 * Page-wide gate on concurrent ticket mints. Module-level on purpose: the limit is a
 * property of the hub, not of any one tile, so every tile has to queue behind the same
 * counter.
 */
let activeMints = 0;
const mintQueue: Array<() => void> = [];

async function withMintSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeMints >= MINT_CONCURRENCY) {
    await new Promise<void>((resolve) => mintQueue.push(resolve));
  }
  activeMints += 1;
  try {
    return await work();
  } finally {
    activeMints -= 1;
    mintQueue.shift()?.();
  }
}

export type StreamState = 'idle' | 'connecting' | 'playing' | 'waiting' | 'failed';

export interface CameraStream {
  /** Feed this straight to an `<img src>`; null while not connected. */
  src: string | null;
  /** Changes on every attempt. Use as the `<img key>` so React remounts the element. */
  attemptKey: number;
  state: StreamState;
  error: string | null;
  /** Report an `<img>` error; schedules a reconnect. */
  onImageError: () => void;
  /** Report a successful decode; promotes to playing and eventually clears backoff. */
  onImageLoad: () => void;
  /** Manual retry, which also clears the attempt counter. */
  retry: () => void;
  stop: () => void;
}

export function useCameraStream({
  agentId,
  enabled,
  /** From `GET /cameras`. The authoritative liveness signal — see CameraStatusView. */
  streaming,
}: {
  agentId: string;
  enabled: boolean;
  streaming: boolean;
}): CameraStream {
  const [src, setSrc] = useState<string | null>(null);
  const [attemptKey, setAttemptKey] = useState(0);
  const [state, setState] = useState<StreamState>('idle');
  const [error, setError] = useState<string | null>(null);

  const attempts = useRef(0);
  const timer = useRef<number | null>(null);
  const playingSince = useRef<number>(0);
  const cancelled = useRef(false);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const connect = useCallback(async () => {
    if (cancelled.current) return;
    setState('connecting');
    setError(null);

    try {
      const { ticket } = await withMintSlot(() => api.streamTicket(agentId));
      if (cancelled.current) return;

      // The ticket is single-use, so the URL must be unique per attempt: a browser that
      // re-requests a previously used src gets a 403. The cache-buster plus the
      // remount key together guarantee a genuinely new request.
      const attempt = attempts.current;
      setSrc(
        `${API_BASE}/cameras/${agentId}/stream?ticket=${encodeURIComponent(ticket)}&a=${attempt}`,
      );
      setAttemptKey(attempt);
    } catch (err) {
      if (cancelled.current) return;
      setError(err instanceof Error ? err.message : 'Could not open the stream.');
      scheduleRetry();
    }
  }, [agentId]);

  const scheduleRetry = useCallback(() => {
    if (cancelled.current) return;

    attempts.current += 1;
    if (attempts.current > MAX_ATTEMPTS) {
      setState('failed');
      setSrc(null);
      return;
    }

    setState('waiting');
    setSrc(null);
    clearTimer();
    timer.current = window.setTimeout(() => void connect(), nextBackoffMs(attempts.current));
  }, [connect]);

  // Open, and re-open whenever the camera comes back. Gating on `streaming` is the
  // main storm suppressor: a stopped camera produces no retry traffic at all, and a
  // whole wall of tiles resumes on its own when the poll flips back.
  useEffect(() => {
    cancelled.current = false;

    if (!enabled || !streaming) {
      clearTimer();
      setSrc(null);
      setState('idle');
      attempts.current = 0;
      return;
    }

    attempts.current = 0;
    void connect();

    return () => {
      cancelled.current = true;
      clearTimer();
      // Dropping the src closes the connection. Without it the browser keeps pulling
      // frames from a detached element and the hub holds a response — and a viewer
      // slot — open for someone who has gone.
      setSrc(null);
    };
  }, [agentId, enabled, streaming, connect]);

  const onImageError = useCallback(() => {
    if (cancelled.current) return;
    scheduleRetry();
  }, [scheduleRetry]);

  const onImageLoad = useCallback(() => {
    setState('playing');
    playingSince.current = Date.now();
    // Only clear the backoff once the stream has proven it can stay up. Resetting on
    // first byte would let a camera that dies every two seconds retry at 1s forever.
    window.setTimeout(() => {
      if (!cancelled.current && Date.now() - playingSince.current >= HEALTHY_AFTER_MS - 50) {
        attempts.current = 0;
      }
    }, HEALTHY_AFTER_MS);
  }, []);

  const retry = useCallback(() => {
    attempts.current = 0;
    clearTimer();
    void connect();
  }, [connect]);

  const stop = useCallback(() => {
    cancelled.current = true;
    clearTimer();
    setSrc(null);
    setState('idle');
  }, []);

  return { src, attemptKey, state, error, onImageError, onImageLoad, retry, stop };
}
