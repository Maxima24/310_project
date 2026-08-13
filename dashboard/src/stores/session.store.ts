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
  connection: ConnectionState;
  signIn: (credential: string) => void;
  signOut: () => void;
  setConnection: (connection: ConnectionState) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  credential: sessionStorage.getItem(STORAGE_KEY) ?? '',
  connection: 'idle',

  signIn: (credential) => {
    sessionStorage.setItem(STORAGE_KEY, credential);
    set({ credential });
  },

  signOut: () => {
    sessionStorage.removeItem(STORAGE_KEY);
    set({ credential: '', connection: 'idle' });
  },

  setConnection: (connection) => set({ connection }),
}));

/**
 * Read the credential outside React — the fetch layer and the socket factory both need
 * it, and neither is a component.
 */
export function currentCredential(): string {
  return useSessionStore.getState().credential;
}
