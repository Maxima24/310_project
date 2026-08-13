import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { Dashboard } from './Dashboard';
import { SignIn } from './components/SignIn';
import { ApiError } from './lib/api';
import { useIdentity } from './lib/queries';
import { AuthProvider } from './lib/permissions';
import { useSessionStore } from './stores/session.store';

/**
 * Gatekeeper.
 *
 * Nothing renders until the hub has told us who we are, because the whole UI is
 * shaped by the returned permissions — guessing and then correcting would flash
 * controls the credential cannot actually use.
 */
export function App() {
  const credential = useSessionStore((s) => s.credential);
  const signOut = useSessionStore((s) => s.signOut);
  const identity = useIdentity();
  const queryClient = useQueryClient();
  const previousCredential = useRef(credential);

  // Wipe the cache whenever the credential changes.
  //
  // Without this, signing out of an admin session and back in as a zone-restricted
  // viewer would briefly render the admin's cached agents, events, and alerts — data
  // the hub would never have sent to that viewer. The cache is per-credential state and
  // must not survive one.
  useEffect(() => {
    if (previousCredential.current !== credential) {
      previousCredential.current = credential;
      queryClient.clear();
    }
  }, [credential, queryClient]);

  // A stored credential the hub no longer accepts (rotated, or the hub reconfigured)
  // must not leave the app stuck on a spinner.
  useEffect(() => {
    if (identity.error instanceof ApiError && identity.error.isAuthFailure) {
      signOut();
    }
  }, [identity.error, signOut]);

  if (!credential) return <SignIn />;

  if (identity.isPending) {
    return (
      <div className="boot">
        <p className="muted">Checking credential…</p>
      </div>
    );
  }

  if (identity.isError || !identity.data) {
    return (
      <div className="boot">
        <p className="signin-error">
          {identity.error instanceof Error ? identity.error.message : 'Could not reach the hub.'}
        </p>
        <button className="link-button" onClick={signOut}>
          Use a different credential
        </button>
      </div>
    );
  }

  return (
    <AuthProvider identity={identity.data}>
      <Dashboard />
    </AuthProvider>
  );
}
