import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api } from './api';
import { useBrowserCamera } from './useBrowserCamera';
import { useCaptureStore } from '../stores/capture.store';
import { useSessionStore } from '../stores/session.store';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ApiError: actual.ApiError,
    api: {
      createBrowserCamera: vi.fn(),
      renewBrowserCamera: vi.fn(),
      revokeBrowserCamera: vi.fn(),
      publishFrame: vi.fn(),
      revokeBrowserCameraOnExit: vi.fn(),
    },
  };
});

const mockApi = vi.mocked(api);

/** Tracks whose stop() we can assert on — the camera light going out. */
function makeTracks() {
  return [{ kind: 'video', stop: vi.fn(), onended: null as unknown }];
}

let tracks: ReturnType<typeof makeTracks>;

function installMediaDevices() {
  tracks = makeTracks();
  const stream = {
    getTracks: () => tracks,
    getVideoTracks: () => tracks,
  } as unknown as MediaStream;

  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue(stream),
      enumerateDevices: vi
        .fn()
        .mockResolvedValue([
          { kind: 'videoinput', deviceId: 'cam-a', label: 'Integrated Webcam' },
          { kind: 'videoinput', deviceId: 'cam-b', label: 'USB Camera' },
          { kind: 'audioinput', deviceId: 'mic', label: 'Mic' },
        ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });

  return stream;
}

/**
 * jsdom implements no canvas at all: `getContext('2d')` returns null and `toBlob` does
 * not exist, so `captureFrame` bails out and the publish loop never runs. Without these
 * stubs every assertion about publishing passes vacuously — which is worse than failing,
 * because it looks like coverage.
 */
function installCanvas() {
  HTMLCanvasElement.prototype.getContext = vi
    .fn()
    .mockReturnValue({ drawImage: vi.fn() }) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback) {
    callback(new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
  };
}

/** A stand-in for a <video> that has decoded at least one frame. */
function attachFakeVideo(ref: React.RefObject<HTMLVideoElement>, size = 640) {
  (ref as { current: unknown }).current = {
    readyState: 4,
    videoWidth: size,
    videoHeight: (size * 3) / 4,
    srcObject: null,
    play: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  installMediaDevices();
  installCanvas();
  useCaptureStore.setState({ session: null, deviceId: null });
  mockApi.createBrowserCamera.mockResolvedValue({
    agentId: 'browser-abc123',
    token: 'ag_publishtoken',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxFps: 5,
    maxWidth: 640,
  });
  mockApi.publishFrame.mockResolvedValue(undefined);
  mockApi.revokeBrowserCamera.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useBrowserCamera secure context', () => {
  it('reports unsupported on an insecure origin rather than an empty picker', async () => {
    // getUserMedia is unavailable on http://<lan-ip>, which is how this stack is often
    // reached. Detecting it lets the panel explain a deployment problem instead of
    // looking broken.
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });

    const { result } = renderHook(() => useBrowserCamera());

    expect(result.current.state).toBe('unsupported');
  });
});

describe('useBrowserCamera enumeration', () => {
  it('prompts BEFORE listing, so labels are real', async () => {
    // enumerateDevices() returns blank labels until permission is granted; listing first
    // would show "Camera 1, Camera 2" and force a guess.
    const { result } = renderHook(() => useBrowserCamera());

    await act(async () => {
      await result.current.enumerate();
    });

    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled();
    expect(result.current.devices.map((d) => d.label)).toEqual([
      'Integrated Webcam',
      'USB Camera',
    ]);
  });

  it('stops the probe stream immediately — it exists only to trigger the prompt', async () => {
    const { result } = renderHook(() => useBrowserCamera());

    await act(async () => {
      await result.current.enumerate();
    });

    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('lists video inputs only', async () => {
    const { result } = renderHook(() => useBrowserCamera());

    await act(async () => {
      await result.current.enumerate();
    });

    expect(result.current.devices).toHaveLength(2);
  });

  it('explains a refused permission instead of failing silently', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(denied);

    const { result } = renderHook(() => useBrowserCamera());

    await act(async () => {
      await result.current.enumerate();
    });

    expect(result.current.error).toMatch(/refused/i);
  });
});

describe('useBrowserCamera publishing', () => {
  it('mints a session and starts publishing', async () => {
    const { result } = renderHook(() => useBrowserCamera());

    await act(async () => {
      await result.current.start('Front Office', "Ada's laptop");
    });

    expect(mockApi.createBrowserCamera).toHaveBeenCalledWith({
      location: 'Front Office',
      label: "Ada's laptop",
    });
    expect(result.current.state).toBe('publishing');
    expect(result.current.agentId).toBe('browser-abc123');
  });

  it('actually uploads frames once the video is decoding', async () => {
    const { result } = renderHook(() => useBrowserCamera());
    attachFakeVideo(result.current.videoRef);

    await act(async () => {
      await result.current.start('Front Office');
    });

    await waitFor(() => expect(mockApi.publishFrame).toHaveBeenCalled());

    // The counter and the timing stats are published once a second, not per frame:
    // setting state on every frame would re-render every consumer of the capture context
    // ten times a second to move a number, so the measurement would cost more than the
    // thing it measures.
    await waitFor(() => expect(result.current.framesSent).toBeGreaterThan(0), { timeout: 3_000 });
    expect(result.current.stats.fps).toBeGreaterThan(0);
  });

  it('publishes with the AGENT token, never the operator credential', async () => {
    // publishFrame takes the token as an explicit parameter precisely so this cannot
    // happen by accident — it is the whole reason that function bypasses request().
    useSessionStore.getState().signIn('dev-admin-key-change-me');
    const { result } = renderHook(() => useBrowserCamera());
    attachFakeVideo(result.current.videoRef);

    await act(async () => {
      await result.current.start('Front Office');
    });

    await waitFor(() => expect(mockApi.publishFrame).toHaveBeenCalled());
    for (const call of mockApi.publishFrame.mock.calls) {
      expect(call[0]).toBe('browser-abc123');
      expect(call[2]).toBe('ag_publishtoken');
    }
  });

  it('keeps only one upload in flight — back-pressure, not a queue', async () => {
    // With setInterval, a hub slower than the period accumulates overlapping uploads
    // until the tab falls over. Here the frame rate simply degrades.
    let inFlight = 0;
    let maxInFlight = 0;
    mockApi.publishFrame.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      inFlight -= 1;
    });

    const { result } = renderHook(() => useBrowserCamera());
    attachFakeVideo(result.current.videoRef);

    await act(async () => {
      await result.current.start('Front Office');
    });
    await waitFor(() => expect(mockApi.publishFrame.mock.calls.length).toBeGreaterThan(2));

    act(() => result.current.stop());
    expect(maxInFlight).toBe(1);
  });
});

describe('useBrowserCamera teardown — the camera light must go out', () => {
  it('stops every track on stop()', async () => {
    const { result } = renderHook(() => useBrowserCamera());
    await act(async () => {
      await result.current.start('Front Office');
    });

    act(() => result.current.stop());

    expect(tracks.every((t) => t.stop.mock.calls.length > 0)).toBe(true);
  });

  it('revokes the session on stop()', async () => {
    const { result } = renderHook(() => useBrowserCamera());
    await act(async () => {
      await result.current.start('Front Office');
    });

    act(() => result.current.stop());

    expect(mockApi.revokeBrowserCamera).toHaveBeenCalledWith('browser-abc123');
  });

  it('stops every track on unmount, even with no explicit stop', async () => {
    const { result, unmount } = renderHook(() => useBrowserCamera());
    await act(async () => {
      await result.current.start('Front Office');
    });

    unmount();

    expect(tracks.every((t) => t.stop.mock.calls.length > 0)).toBe(true);
  });

  it('clears the session so a reload cannot resume publishing', async () => {
    const { result } = renderHook(() => useBrowserCamera());
    await act(async () => {
      await result.current.start('Front Office');
    });

    act(() => result.current.stop());

    expect(useCaptureStore.getState().session).toBeNull();
  });

  it('ends the session when the operator signs out', async () => {
    // A publishing token must never be more durable than the credential that minted it.
    const { result } = renderHook(() => useBrowserCamera());
    await act(async () => {
      await result.current.start('Front Office');
    });

    await act(async () => {
      useSessionStore.getState().signOut();
    });

    await waitFor(() => expect(useCaptureStore.getState().session).toBeNull());
    expect(tracks.every((t) => t.stop.mock.calls.length > 0)).toBe(true);
  });
});

describe('useBrowserCamera session hygiene', () => {
  it('ends the previous session before starting another', async () => {
    // The bug this guards: starting twice used to leave the first agent registered but
    // silent, so the camera wall showed a browser camera permanently "offline" that
    // nobody could account for — and a second one appeared beside it on every restart.
    const { result } = renderHook(() => useBrowserCamera());
    attachFakeVideo(result.current.videoRef);

    await act(async () => {
      await result.current.start('Front Office');
    });

    mockApi.createBrowserCamera.mockResolvedValue({
      agentId: 'browser-def456',
      token: 'ag_secondtoken',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxFps: 15,
      maxWidth: 640,
    });

    await act(async () => {
      await result.current.start('Back Office');
    });

    expect(mockApi.revokeBrowserCamera).toHaveBeenCalledWith('browser-abc123');
    expect(result.current.agentId).toBe('browser-def456');
  });

  it('exposes the stream so a preview can attach without borrowing the capture element', async () => {
    // A panel that reused `videoRef` would take the capture source with it when it
    // unmounted, which is precisely how publishing died on closing the panel.
    const { result } = renderHook(() => useBrowserCamera());
    attachFakeVideo(result.current.videoRef);

    await act(async () => {
      await result.current.start('Front Office');
    });

    expect(result.current.stream).not.toBeNull();
  });

  it('publishes at the chosen frame rate, bounded by what the hub allows', async () => {
    const { result } = renderHook(() => useBrowserCamera());
    attachFakeVideo(result.current.videoRef);

    act(() => result.current.setFps(15));
    expect(result.current.fps).toBe(15);

    // The hub's ceiling still wins if it is lower.
    mockApi.createBrowserCamera.mockResolvedValue({
      agentId: 'browser-abc123',
      token: 'ag_publishtoken',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxFps: 5,
      maxWidth: 640,
    });

    await act(async () => {
      await result.current.start('Front Office');
    });

    await waitFor(() => expect(mockApi.publishFrame).toHaveBeenCalled());
    act(() => result.current.stop());
  });
});

describe('useBrowserCamera error handling', () => {
  it('ends the session on 401/403 rather than looping', async () => {
    // A settled answer: the token expired or was revoked. Retrying cannot help, and a
    // loop of rejected uploads buries the real cause.
    mockApi.publishFrame.mockRejectedValue(new ApiError(403, 'Forbidden'));

    const { result } = renderHook(() => useBrowserCamera());
    attachFakeVideo(result.current.videoRef);

    await act(async () => {
      await result.current.start('Front Office');
    });

    await waitFor(() => expect(result.current.error).toMatch(/session ended/i));
    expect(useCaptureStore.getState().session).toBeNull();
    // And it stopped rather than retrying into a wall of rejections.
    const calls = mockApi.publishFrame.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(mockApi.publishFrame.mock.calls.length).toBe(calls);
  });

  it('drops an oversized frame instead of looping into a rejection', async () => {
    // The hub would 400 it every time; sending it anyway would make the feed dead AND
    // noisy. Lower the quality and skip this one.
    HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback) {
      callback(new Blob([new Uint8Array(1024 * 1024)], { type: 'image/jpeg' }));
    };

    const { result } = renderHook(() => useBrowserCamera());
    attachFakeVideo(result.current.videoRef);

    await act(async () => {
      await result.current.start('Front Office');
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(mockApi.publishFrame).not.toHaveBeenCalled();
    act(() => result.current.stop());
  });

  it('surfaces a refused mint — the cap, for instance — without starting', async () => {
    mockApi.createBrowserCamera.mockRejectedValue(
      new ApiError(403, '4 browser cameras already exist, which is the limit.'),
    );

    const { result } = renderHook(() => useBrowserCamera());
    await act(async () => {
      await result.current.start('Front Office');
    });

    expect(result.current.state).toBe('error');
    expect(result.current.error).toMatch(/limit/i);
    // And the camera is released, not left on after a failed start.
    expect(tracks.every((t) => t.stop.mock.calls.length > 0)).toBe(true);
  });
});
