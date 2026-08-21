import { createContext, useContext, type ReactNode } from 'react';

import { useBrowserCamera, type BrowserCameraController } from './useBrowserCamera';

/**
 * Owns the browser's camera capture for the whole application.
 *
 * WHY THIS EXISTS. The capture was originally started by the panel that configures it,
 * which meant closing that panel unmounted the hook, stopped the tracks, and killed the
 * upload loop — while the session stayed registered on the hub. The camera wall then
 * showed a browser camera that was permanently "offline", and pressing start again
 * created a second one beside it. Publishing is application state, not panel state, so
 * it belongs above the router.
 *
 * The capture <video> lives here too. It is the element frames are drawn from, so if it
 * unmounted with the panel there would be nothing to read even with the stream alive.
 * A preview elsewhere attaches `controller.stream` to its own element instead — several
 * <video> elements can share one MediaStream.
 */

const CaptureContext = createContext<BrowserCameraController | null>(null);

export function CaptureProvider({ children }: { children: ReactNode }) {
  const controller = useBrowserCamera();

  return (
    <CaptureContext.Provider value={controller}>
      {children}
      {/*
        The capture source. Every property here is load-bearing:

        `autoPlay` as well as the explicit play() in start(), because a video that is
        never playing never reaches readyState 2, and the capture then silently returns
        no frame on every tick — the session looks alive and uploads nothing.

        Given real dimensions and left in the layout rather than `display: none` or a 1px
        box: a hidden or zero-area video is allowed to stop decoding, and a source that
        is not decoding is the same failure by a different route. It is pushed behind the
        page and made all but invisible instead, which keeps it decoding.
      */}
      <video
        ref={controller.videoRef}
        autoPlay
        muted
        playsInline
        aria-hidden="true"
        width={160}
        height={120}
        style={{
          position: 'fixed',
          right: 0,
          bottom: 0,
          width: 160,
          height: 120,
          opacity: 0.001,
          zIndex: -1,
          pointerEvents: 'none',
        }}
      />
    </CaptureContext.Provider>
  );
}

export function useCapture(): BrowserCameraController {
  const controller = useContext(CaptureContext);
  if (!controller) throw new Error('useCapture must be used inside <CaptureProvider>');
  return controller;
}
