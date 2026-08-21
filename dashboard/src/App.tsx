import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { Shell } from './Shell';
import { SignIn } from './components/SignIn';
import { ApiError } from './lib/api';
import { useIdentity } from './lib/queries';
import { AuthProvider } from './lib/permissions';
import { CamerasPage } from './pages/CamerasPage';
import { Overview } from './pages/Overview';
import { ReportsPage } from './pages/ReportsPage';
import { SettingsPage } from './pages/SettingsPage';
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
        <span className="spinner" aria-hidden="true" />
        <p className="muted">Checking credential…</p>
      </div>
    );
  }

  if (identity.isError || !identity.data) {
    return (
      <div className="boot">
        <p className="form-error">
          {identity.error instanceof Error ? identity.error.message : 'Could not reach the hub.'}
        </p>
        <button className="link-btn" onClick={signOut}>
          Use a different credential
        </button>
      </div>
    );
  }

  return (
    <AuthProvider identity={identity.data}>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/" element={<Overview />} />
            <Route path="/cameras" element={<CamerasPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* An unknown URL lands on the overview rather than a blank shell — on an
                operations console, "where am I" should never be a question. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
