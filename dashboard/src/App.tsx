import { useEffect } from 'react';

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

  // Note: nothing clears the query cache here on purpose. An earlier version called
  // queryClient.clear() from an effect on credential change, which could leave this
  // very query observer with no query AND no fetch in flight — the screen below then
  // sat on "Checking credential…" forever. Query keys carry the session generation
  // instead, so the previous identity's data is unreachable rather than deleted.

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
