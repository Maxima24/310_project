import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api';
import { nextBackoffMs, useCameraStream } from './useCameraStream';

vi.mock('./api', () => ({
  api: { streamTicket: vi.fn() },
}));

const streamTicket = vi.mocked(api.streamTicket);

beforeEach(() => {
  let n = 0;
  streamTicket.mockImplementation(() =>
    Promise.resolve({
      ticket: `ticket-${(n += 1)}`,
      expiresInMs: 30_000,
      streamUrl: '/cameras/cam/stream',
    }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('nextBackoffMs', () => {
  it('starts around a second, not immediately', () => {
    // An instant retry against a camera that just died is a tight loop against the hub.
    const delay = nextBackoffMs(1, () => 1);

    expect(delay).toBeLessThanOrEqual(1_000);
    expect(delay).toBeGreaterThan(0);
  });

  it('doubles with each attempt', () => {
    expect([1, 2, 3, 4].map((a) => nextBackoffMs(a, () => 1))).toEqual([1_000, 2_000, 4_000, 8_000]);
  });

  it('caps at 30 seconds however long the outage lasts', () => {
    // Unbounded doubling means a camera back after an hour goes unnoticed for another.
    expect(nextBackoffMs(20, () => 1)).toBe(30_000);
    expect(nextBackoffMs(100, () => 1)).toBe(30_000);
  });

  it('jitters between half and full, so a wall of tiles does not stampede', () => {
    expect(nextBackoffMs(3, () => 0)).toBe(2_000);
    expect(nextBackoffMs(3, () => 1)).toBe(4_000);
  });

  it('treats attempt 0 as the first attempt rather than going negative', () => {
    expect(nextBackoffMs(0, () => 1)).toBe(1_000);
  });
});

describe('useCameraStream connection', () => {
  it('connects and exposes a src carrying the minted ticket', async () => {
    const { result } = renderHook(() =>
      useCameraStream({ agentId: 'cam', enabled: true, streaming: true }),
    );

    await waitFor(() => expect(result.current.src).toBeTruthy());
    expect(result.current.src).toContain('ticket-1');
    expect(result.current.src).toContain('/cameras/cam/stream');
  });

  it('mints exactly ONE ticket per mount', async () => {
    // The StrictMode regression: the old `cancelled` flag was reset at the top of the
    // effect, un-setting what the previous cleanup had set, so the discarded run's
    // awaited mint still wrote state. Two tickets, two viewer claims, and an <img key>
    // that never changed — so React mutated src in place and re-requested a consumed
    // single-use ticket, which 403s.
    const { result } = renderHook(() =>
      useCameraStream({ agentId: 'cam', enabled: true, streaming: true }),
    );

    await waitFor(() => expect(result.current.src).toBeTruthy());
    expect(streamTicket).toHaveBeenCalledTimes(1);
  });

  it('gives every attempt a strictly increasing key, forcing a remount', async () => {
    const { result } = renderHook(() =>
      useCameraStream({ agentId: 'cam', enabled: true, streaming: true }),
    );
    await waitFor(() => expect(result.current.src).toBeTruthy());
    const first = result.current.attemptKey;

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.attemptKey).toBeGreaterThan(first));
  });

  it('mints nothing at all when the camera reports no frames', async () => {
    // Storm suppression: a wall of stopped cameras must generate zero traffic.
    const { result } = renderHook(() =>
      useCameraStream({ agentId: 'cam', enabled: false, streaming: false }),
    );

    await waitFor(() => expect(result.current.state).toBe('idle'));
    expect(streamTicket).not.toHaveBeenCalled();
  });

  it('sits in standby — not failed — when enabled but the camera is silent', async () => {
    const { result } = renderHook(() =>
      useCameraStream({ agentId: 'cam', enabled: true, streaming: false }),
    );

    await waitFor(() => expect(result.current.state).toBe('standby'));
    expect(streamTicket).not.toHaveBeenCalled();
  });

  it('leaves standby on its own when the camera comes back', async () => {
    // This is what makes a wall recover unaided after the cameras restart.
    const { result, rerender } = renderHook(
      ({ streaming }) => useCameraStream({ agentId: 'cam', enabled: true, streaming }),
      { initialProps: { streaming: false } },
    );
    await waitFor(() => expect(result.current.state).toBe('standby'));

    rerender({ streaming: true });

    await waitFor(() => expect(result.current.src).toBeTruthy());
  });
});

describe('useCameraStream and the stale liveness poll', () => {
  it('does NOT drop a playing stream when the poll reports streaming: false', async () => {
    // The blanking regression. `streaming` is a 10s poll of a flag with a 10s TTL, so
    // it routinely lags reality; as an effect dependency it tore down connections that
    // were visibly delivering frames.
    const { result, rerender } = renderHook(
      ({ streaming }) => useCameraStream({ agentId: 'cam', enabled: true, streaming }),
      { initialProps: { streaming: true } },
    );
    await waitFor(() => expect(result.current.src).toBeTruthy());

    act(() => result.current.onImageLoad());
    expect(result.current.state).toBe('playing');

    rerender({ streaming: false });

    expect(result.current.src).toBeTruthy();
    expect(result.current.state).toBe('playing');
  });

  it('parks in standby without burning the retry budget when the camera is down', async () => {
    const { result, rerender } = renderHook(
      ({ streaming }) => useCameraStream({ agentId: 'cam', enabled: true, streaming }),
      { initialProps: { streaming: true } },
    );
    await waitFor(() => expect(result.current.src).toBeTruthy());

    rerender({ streaming: false });
    act(() => result.current.onImageError());

    await waitFor(() => expect(result.current.state).toBe('standby'));
  });
});

describe('useCameraStream failure handling', () => {
  it('keeps retrying after admitting failure, instead of latching dead', async () => {
    // A tile that lost ~31s of connectivity used to stay blank until a human clicked
    // it, which on an unattended wall display looks exactly like a broken camera.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    streamTicket.mockRejectedValue(new Error('hub down'));

    const { result } = renderHook(() =>
      useCameraStream({ agentId: 'cam', enabled: true, streaming: true }),
    );

    await waitFor(() => expect(result.current.state).toBe('waiting'));

    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
    }

    expect(result.current.state).toBe('failed');
    const callsSoFar = streamTicket.mock.calls.length;

    // Still trying in the background.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(streamTicket.mock.calls.length).toBeGreaterThan(callsSoFar);
  });

  it('surfaces the hub’s reason for a refused ticket', async () => {
    streamTicket.mockRejectedValue(new Error('Too many viewers'));

    const { result } = renderHook(() =>
      useCameraStream({ agentId: 'cam', enabled: true, streaming: true }),
    );

    await waitFor(() => expect(result.current.error).toBe('Too many viewers'));
  });
});

describe('useCameraStream teardown', () => {
  it('drops the src on unmount so the hub releases the viewer slot', async () => {
    const { result, unmount } = renderHook(() =>
      useCameraStream({ agentId: 'cam', enabled: true, streaming: true }),
    );
    await waitFor(() => expect(result.current.src).toBeTruthy());

    unmount();
    // No assertion on state after unmount — the point is that nothing throws and no
    // timer fires later. The guard below catches the latter.
    expect(streamTicket).toHaveBeenCalledTimes(1);
  });

  it('does not fire a stale timer after unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    streamTicket.mockRejectedValue(new Error('hub down'));

    const { result, unmount } = renderHook(() =>
      useCameraStream({ agentId: 'cam', enabled: true, streaming: true }),
    );
    await waitFor(() => expect(result.current.state).toBe('waiting'));

    const before = streamTicket.mock.calls.length;
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(streamTicket.mock.calls.length).toBe(before);
  });

  it('can be restarted after stop — stop is not terminal', async () => {
    // The old stop() set a `cancelled` flag nothing ever cleared, so a stopped tile was
    // dead until it unmounted.
    const { result } = renderHook(() =>
      useCameraStream({ agentId: 'cam', enabled: true, streaming: true }),
    );
    await waitFor(() => expect(result.current.src).toBeTruthy());

    act(() => result.current.stop());
    expect(result.current.src).toBeNull();

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.src).toBeTruthy());
  });
});
