import { create } from 'zustand';

/**
 * Session state: the operator credential and the socket's connection status.
 *
 * Zustand holds CLIENT state only. Nothing here is server data — agents, events,
 * alerts, and the arm mode all live in the TanStack Query cache, so there is exactly
 * one copy of each and no chance of a panel disagreeing with a refetch.
 */

export type ConnectionState = 'idle' | 'connecting' | 'live' | 'rejected' | 'offline';

/**
 * sessionStorage, not localStorage: this is the credential that can disarm a building,
 * so it should not outlive the tab. It is deliberately not in Zustand's persisted
 * state either — the store reads it once on load and writes through.
 */
const STORAGE_KEY = 'cpe310.operatorKey';

interface SessionState {
  credential: string;
  /**
   * Bumped on every sign-in and sign-out, and mixed into every query key.
   *
   * This is how one identity's cached data is kept away from the next, and it replaces
   * an earlier `queryClient.clear()` on credential change. Clearing the cache from a
   * render effect could leave a mounted query observer with no query and no fetch in
   * flight — permanently "loading". Scoping the keys instead means the old data is
   * simply unreachable and the new session fetches from scratch, with no window in
   * which a viewer could see an admin's data.
   */
  sessionId: number;
  connection: ConnectionState;
  signIn: (credential: string) => void;
  signOut: () => void;
  setConnection: (connection: ConnectionState) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  credential: sessionStorage.getItem(STORAGE_KEY) ?? '',
  sessionId: 1,
  connection: 'idle',

  signIn: (credential) => {
    sessionStorage.setItem(STORAGE_KEY, credential);
    set((state) => ({ credential, sessionId: state.sessionId + 1 }));
  },

  signOut: () => {
    sessionStorage.removeItem(STORAGE_KEY);
    set((state) => ({ credential: '', connection: 'idle', sessionId: state.sessionId + 1 }));
  },

  setConnection: (connection) => set({ connection }),
}));

/** Current session generation, for code outside React (the socket layer). */
export function currentSessionId(): number {
  return useSessionStore.getState().sessionId;
}

/**
 * Read the credential outside React — the fetch layer and the socket factory both need
 * it, and neither is a component.
 */
export function currentCredential(): string {
  return useSessionStore.getState().credential;
}
