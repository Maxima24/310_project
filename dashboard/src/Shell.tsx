import { useQueryClient } from '@tanstack/react-query';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { TopBar } from './components/TopBar';
import { CaptureProvider } from './lib/CaptureProvider';
import { usePermissions } from './lib/permissions';
import { useHubSocket } from './lib/useHubSocket';
import { ROUTES, mayAccess } from './routes';
import { useSessionStore } from './stores/session.store';

/**
 * Application layout, and the one place the live socket is opened.
 *
 * The socket lives here rather than on the Overview page so it stays connected while
 * the operator is looking at Cameras or Settings — a security console that stops
 * receiving alerts because someone navigated away would be worse than one with no
 * realtime at all, because it looks like it is working.
 */
export function Shell() {
  const queryClient = useQueryClient();
  const credential = useSessionStore((s) => s.credential);
  const { canReadAlerts, identity } = usePermissions();
  const location = useLocation();

  useHubSocket(credential, canReadAlerts);

  // Deep links are the point of having routes, so a URL typed or pasted for a page this
  // credential cannot open is redirected rather than left to 403 panel by panel. The
  // hub enforces the same rule; this only avoids showing a broken page.
  const route = ROUTES.find((entry) => entry.path === location.pathname);
  if (route && !mayAccess(route, identity.permissions)) {
    return <Navigate to="/" replace />;
  }

  return (
    // CaptureProvider wraps the router, not a page: a browser camera must keep publishing
    // while the operator navigates, and its capture element must outlive the panel that
    // started it.
    <CaptureProvider>
      <div className="shell">
        <TopBar onRefresh={() => void queryClient.invalidateQueries()} />
        <main className="page">
          <Outlet />
        </main>
      </div>
    </CaptureProvider>
  );
}
