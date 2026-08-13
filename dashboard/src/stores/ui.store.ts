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

  setAlertFilter: (filter: AlertFilter) => void;
  focusAgent: (agentId: string | null) => void;
  toggleSound: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      alertFilter: 'open',
      focusedAgentId: null,
      soundOnCritical: false,

      setAlertFilter: (alertFilter) => set({ alertFilter }),
      // Clicking the focused agent again clears the filter, which is the behaviour
      // people expect from a toggle.
      focusAgent: (agentId) =>
        set((state) => ({
          focusedAgentId: state.focusedAgentId === agentId ? null : agentId,
        })),
      toggleSound: () => set((state) => ({ soundOnCritical: !state.soundOnCritical })),
    }),
    {
      name: 'cpe310.ui',
      // Deliberately does not persist focusedAgentId: a filter narrowing the view to
      // one sensor should not silently survive a reload and hide the rest of the
      // building from someone who has forgotten they set it.
      partialize: (state) => ({
        alertFilter: state.alertFilter,
        soundOnCritical: state.soundOnCritical,
      }),
    },
  ),
);
