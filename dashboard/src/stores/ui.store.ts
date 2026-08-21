import { MAX_CONCURRENT_STREAMS, type CameraStatusView } from '@cpe310/contracts';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * View preferences and filters — genuinely client state, so it belongs here rather
 * than in the Query cache.
 *
 * Persisted (unlike the credential) because these are harmless preferences, and an
 * operator who hid acknowledged alerts expects it to stay that way across a reload.
 */

export type AlertFilter = 'all' | 'open' | 'critical';

interface UiState {
  alertFilter: AlertFilter;
  /** Filters the event stream to one agent, set by clicking an agent card. */
  focusedAgentId: string | null;
  /** Audible cue on a new critical alert — a wall display is not always watched. */
  soundOnCritical: boolean;

  /**
   * Cameras currently being watched.
   *
   * Lives here rather than in LiveView's component state, and that IS the fix for a
   * dead-looking wall: component state was discarded on every unmount, so navigating
   * Overview -> Cameras -> back dropped every tile to its play button. The store
   * outlives the router, so the intent survives even though the MJPEG connections
   * themselves cannot (each is owned by its <img>, which the route change unmounts).
   *
   * NOT persisted. A watch list restored from last session would pin all four slots to
   * cameras that are dead now, starving the ones that are actually live.
   */
  cameraWatch: string[];
  /** "Do not auto-watch this one." A preference, so it survives a reload. */
  cameraOptOut: string[];
  /**
   * Paused tiles: the connection is dropped but the last frame stays on screen.
   *
   * Not persisted, but stored here rather than in the tile so it survives navigation.
   * Component-local pause silently un-paused when you changed page, which on a
   * security feed is a lie — the operator believes a camera is frozen while it is not.
   */
  cameraPaused: string[];

  setAlertFilter: (filter: AlertFilter) => void;
  focusAgent: (agentId: string | null) => void;
  toggleSound: () => void;

  reconcileCameraWatch: (cameras: CameraStatusView[]) => void;
  startWatchingCamera: (agentId: string) => void;
  stopWatchingCamera: (agentId: string) => void;
  toggleCameraPaused: (agentId: string) => void;
  resumeAllCameras: () => void;
}

/**
 * Picks which cameras auto-start, given what is live and what has been opted out.
 *
 * Exported and pure so the rules below are testable without a store or a render.
 *
 * Three properties, each chosen against a specific failure:
 *
 *  - **A watched camera keeps its slot when `streaming` goes false.** Only vanishing
 *    from the list entirely releases it. Otherwise a flapping camera hands its slot to
 *    another one the moment it stutters and can never get it back — the wall would
 *    reshuffle itself every poll.
 *  - **Nothing is ever evicted to make room.** First come, stable. A tile that is
 *    playing must not be closed by a background reconcile.
 *  - **Deterministic order** — location, then id. Deliberately not "most recent frames"
 *    or "fewest viewers": both make the selection unreproducible and change under the
 *    operator as an fps figure wobbles.
 */
export function selectAutoWatch(
  cameras: CameraStatusView[],
  current: string[],
  optOut: string[],
): string[] {
  const present = new Set(cameras.map((camera) => camera.agentId));
  const kept = current.filter((id) => present.has(id));

  const candidates = cameras
    .filter(
      (camera) =>
        camera.streaming && !optOut.includes(camera.agentId) && !kept.includes(camera.agentId),
    )
    .sort(
      (a, b) =>
        a.location.localeCompare(b.location) || a.agentId.localeCompare(b.agentId),
    )
    .map((camera) => camera.agentId);

  const next = [...kept, ...candidates.slice(0, Math.max(0, MAX_CONCURRENT_STREAMS - kept.length))];

  // Same contents, same order -> hand back the ORIGINAL reference. The camera poll runs
  // every 10s, and a fresh array each time would re-render every tile on the wall.
  return next.length === current.length && next.every((id, i) => id === current[i])
    ? current
    : next;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      alertFilter: 'open',
      focusedAgentId: null,
      soundOnCritical: false,
      cameraWatch: [],
      cameraOptOut: [],
      cameraPaused: [],

      setAlertFilter: (alertFilter) => set({ alertFilter }),
      // Clicking the focused agent again clears the filter, which is the behaviour
      // people expect from a toggle.
      focusAgent: (agentId) =>
        set((state) => ({
          focusedAgentId: state.focusedAgentId === agentId ? null : agentId,
        })),
      toggleSound: () => set((state) => ({ soundOnCritical: !state.soundOnCritical })),

      reconcileCameraWatch: (cameras) =>
        set((state) => {
          const cameraWatch = selectAutoWatch(cameras, state.cameraWatch, state.cameraOptOut);
          return cameraWatch === state.cameraWatch ? {} : { cameraWatch };
        }),

      startWatchingCamera: (agentId) =>
        set((state) => {
          const cameraOptOut = state.cameraOptOut.filter((id) => id !== agentId);
          if (state.cameraWatch.includes(agentId)) return { cameraOptOut };

          // At capacity we refuse rather than evicting someone. Silently closing a tile
          // the operator is watching to open a different one is worse than saying no —
          // LiveView surfaces this as "Limit N reached".
          if (state.cameraWatch.length >= MAX_CONCURRENT_STREAMS) return { cameraOptOut };

          return { cameraOptOut, cameraWatch: [...state.cameraWatch, agentId] };
        }),

      // Stop means "and don't put it back": without the opt-out, the next reconcile
      // would re-add it a few seconds later and the button would look broken. The freed
      // slot is taken by the next candidate on the following poll, which is intended —
      // the wall stays full.
      stopWatchingCamera: (agentId) =>
        set((state) => ({
          cameraWatch: state.cameraWatch.filter((id) => id !== agentId),
          cameraPaused: state.cameraPaused.filter((id) => id !== agentId),
          cameraOptOut: state.cameraOptOut.includes(agentId)
            ? state.cameraOptOut
            : [...state.cameraOptOut, agentId],
        })),

      toggleCameraPaused: (agentId) =>
        set((state) => ({
          cameraPaused: state.cameraPaused.includes(agentId)
            ? state.cameraPaused.filter((id) => id !== agentId)
            : [...state.cameraPaused, agentId],
        })),

      // The undo for Stop. A persisted opt-out with no visible way back is how an
      // operator concludes a camera is broken when they only ever paused it.
      resumeAllCameras: () => set({ cameraOptOut: [] }),
    }),
    {
      name: 'cpe310.ui',
      // Deliberately does not persist focusedAgentId: a filter narrowing the view to
      // one sensor should not silently survive a reload and hide the rest of the
      // building from someone who has forgotten they set it.
      //
      // cameraWatch and cameraPaused are omitted for the reasons on their declarations:
      // both describe this session, not a preference.
      partialize: (state) => ({
        alertFilter: state.alertFilter,
        soundOnCritical: state.soundOnCritical,
        cameraOptOut: state.cameraOptOut,
      }),
    },
  ),
);
