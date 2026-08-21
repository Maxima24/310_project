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

/** Attempts before the tile ADMITS it is failing. It keeps retrying regardless. */
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

/**
 * `standby` is the deliberate-idle state: the camera reports no frames, so there is
 * nothing to connect to and we are not going to keep asking. It is distinct from
 * `idle` (nobody asked for this stream) and from `failed` (we asked and could not).
 * Only `standby` should ever render as "No signal".
 */
export type StreamState =
  | 'idle'
  | 'standby'
  | 'connecting'
  | 'playing'
  | 'waiting'
  | 'failed';

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
  /** From `GET /cameras`. Polled, so it LAGS reality — see streamingRef below. */
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
  const healthTimer = useRef<number | null>(null);
  const firstLoadAt = useRef<number>(0);

  /**
   * Generation token, replacing an earlier `cancelled` boolean.
   *
   * The boolean was reset at the top of the effect body, which un-set what the previous
   * cleanup had just set — so under StrictMode the discarded first run's awaited ticket
   * still passed the guard and called setSrc. Two mints, two viewer claims, and because
   * both runs computed the same attempt number the `<img key>` never changed: React
   * mutated `src` in place instead of remounting, re-requesting a single-use ticket that
   * had already been redeemed, which 403s. A monotonic token cannot be un-set by a
   * later run, so a stale attempt can never write.
   */
  const runId = useRef(0);

  /**
   * The `<img key>` and cache-buster. Separate from `attempts` and strictly increasing:
   * `attempts` legitimately resets to 0 (manual retry, healthy stream), and reusing it
   * as the key meant two different attempts could share one key and skip the remount.
   */
  const keyRef = useRef(0);

  /**
   * The polled liveness flag, held in a ref rather than an effect dependency.
   *
   * As a dependency it tore down a PLAYING stream whenever the 10s poll happened to
   * report false — and since the hub's frame TTL is also 10s, that is a routine race,
   * not an edge case. As a ref it informs decisions without being able to interrupt a
   * connection that is visibly working.
   */
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;

  const clearTimers = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (healthTimer.current !== null) {
      window.clearTimeout(healthTimer.current);
      healthTimer.current = null;
    }
  }, []);

  /**
   * One ref holds the whole connect/retry cycle, so the two halves cannot capture stale
   * copies of each other. Previously `connect` closed over the first `scheduleRetry`,
   * which closed over the first `connect` — a circular pair of stale closures that was
   * harmless only because `agentId` never changes.
   */
  const cycle = useRef({
    connect: async (_run: number): Promise<void> => {},
    scheduleRetry: (_run: number): void => {},
  });

  cycle.current.connect = async (run: number) => {
    if (runId.current !== run) return;

    // Nothing to connect to. Deliberately idle rather than retrying: a stopped camera
    // must produce no traffic at all, or a wall of them becomes a retry storm.
    if (!streamingRef.current) {
      setState('standby');
      setSrc(null);
      return;
    }

    setState('connecting');
    setError(null);

    try {
      const { ticket } = await withMintSlot(() => api.streamTicket(agentId));
      if (runId.current !== run) return;

      // The ticket is single-use, so the URL must be unique per attempt: a browser that
      // re-requests a previously used src gets a 403. The cache-buster plus the
      // remount key together guarantee a genuinely new request.
      keyRef.current += 1;
      firstLoadAt.current = 0;
      setSrc(
        `${API_BASE}/cameras/${agentId}/stream?ticket=${encodeURIComponent(ticket)}&a=${keyRef.current}`,
      );
      setAttemptKey(keyRef.current);
    } catch (err) {
      if (runId.current !== run) return;
      setError(err instanceof Error ? err.message : 'Could not open the stream.');
      cycle.current.scheduleRetry(run);
    }
  };

  cycle.current.scheduleRetry = (run: number) => {
    if (runId.current !== run) return;

    setSrc(null);
    clearTimers();

    // The camera itself is down. Park without burning the retry budget, so that when it
    // returns the tile has its full ladder rather than being one attempt from giving up.
    if (!streamingRef.current) {
      setState('standby');
      return;
    }

    attempts.current += 1;

    // Past the threshold we SAY we are failing — but we keep trying at the 30s ceiling.
    // Latching dead here meant a tile that lost ~31s of connectivity stayed blank until
    // a human clicked it, which on an unattended wall display is indistinguishable from
    // a broken camera.
    setState(attempts.current > MAX_ATTEMPTS ? 'failed' : 'waiting');

    timer.current = window.setTimeout(
      () => void cycle.current.connect(run),
      nextBackoffMs(attempts.current),
    );
  };

  // Open, and tear down only when this tile genuinely stops being wanted. Note that
  // `streaming` is NOT a dependency: it is consulted through the ref instead, so a
  // stale poll can no longer interrupt a working stream.
  useEffect(() => {
    const run = ++runId.current;

    if (!enabled) {
      clearTimers();
      setSrc(null);
      setState('idle');
      attempts.current = 0;
      return;
    }

    attempts.current = 0;
    void cycle.current.connect(run);

    return () => {
      runId.current += 1;
      clearTimers();
      // Dropping the src closes the connection. Without it the browser keeps pulling
      // frames from a detached element and the hub holds a response — and a viewer
      // slot — open for someone who has gone.
      setSrc(null);
    };
  }, [agentId, enabled, clearTimers]);

  // The camera came back. Reconnecting from standby is what makes a wall recover on its
  // own after the cameras restart, with no click anywhere.
  useEffect(() => {
    if (!enabled || !streaming || state !== 'standby') return;

    attempts.current = 0;
    void cycle.current.connect(runId.current);
  }, [enabled, streaming, state]);

  const onImageError = useCallback(() => {
    cycle.current.scheduleRetry(runId.current);
  }, []);

  const onImageLoad = useCallback(() => {
    setState('playing');

    // A multipart stream fires `load` on EVERY decoded part, not once per connection.
    // The previous version restamped its timestamp on each one and then asked whether
    // 10s had elapsed since the most recent frame — which at 5fps is never true, so the
    // backoff reset never ran. Anchor on the FIRST load of this attempt instead, and arm
    // the timer once.
    if (firstLoadAt.current !== 0) return;
    firstLoadAt.current = Date.now();

    const run = runId.current;
    healthTimer.current = window.setTimeout(() => {
      // Only clear the backoff once the stream has proven it can stay up. Resetting on
      // first byte would let a camera that dies every two seconds retry at 1s forever.
      if (runId.current === run) attempts.current = 0;
    }, HEALTHY_AFTER_MS);
  }, []);

  const retry = useCallback(() => {
    attempts.current = 0;
    clearTimers();
    void cycle.current.connect(++runId.current);
  }, [clearTimers]);

  const stop = useCallback(() => {
    // Bumping the generation is the whole teardown: every in-flight attempt is orphaned
    // and can no longer write. The old version set a `cancelled` flag that nothing ever
    // cleared, so a stopped tile stayed dead until it unmounted.
    runId.current += 1;
    clearTimers();
    setSrc(null);
    setState('idle');
  }, [clearTimers]);

  return { src, attemptKey, state, error, onImageError, onImageLoad, retry, stop };
}
