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

/**
 * The operator's name, sent with every write so the audit trail reads as a shift log
 * rather than a list of anonymous role changes.
 *
 * localStorage rather than sessionStorage, and deliberately so: unlike the credential
 * this is not a secret, and the same person at the same console should not have to
 * retype their name every tab. It is also NOT identity — see `label` below.
 */
const LABEL_KEY = 'cpe310.operatorLabel';

interface SessionState {
  credential: string;
  /**
   * Self-asserted display name. The hub records it verbatim and marks it unverified,
   * because with shared per-role credentials there is nothing to check it against —
   * anyone holding the operator key can type any name, including someone else's.
   *
   * It is worth having anyway: "Ada disarmed at 07:12" is a more useful line than
   * "an operator disarmed at 07:12", as long as nobody mistakes it for proof.
   */
  label: string;
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
  signIn: (credential: string, label?: string) => void;
  signOut: () => void;
  setConnection: (connection: ConnectionState) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  credential: sessionStorage.getItem(STORAGE_KEY) ?? '',
  label: localStorage.getItem(LABEL_KEY) ?? '',
  sessionId: 1,
  connection: 'idle',

  signIn: (credential, label = '') => {
    sessionStorage.setItem(STORAGE_KEY, credential);
    if (label) localStorage.setItem(LABEL_KEY, label);
    set((state) => ({ credential, label, sessionId: state.sessionId + 1 }));
  },

  signOut: () => {
    sessionStorage.removeItem(STORAGE_KEY);
    // The name survives sign-out on purpose: it is not a secret, and the next shift at
    // this console overwrites it at sign-in anyway.
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

/** The claimed operator name, for the audit header. Empty means "do not send one". */
export function currentLabel(): string {
  return useSessionStore.getState().label;
}
