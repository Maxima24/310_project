import { NavLink } from 'react-router-dom';

import { Icon, IconButton } from './ui';
import { usePermissions } from '../lib/permissions';
import { ROUTES, mayAccess } from '../routes';
import { useSessionStore } from '../stores/session.store';

/**
 * Application shell header.
 *
 * The nav is a single pill group with the active item expanded to show its label —
 * icons alone are ambiguous, labels alone are wide, and this gets both without a
 * tooltip.
 *
 * Items are filtered by permission rather than disabled, because unlike the earlier
 * "not built yet" state these are real pages that some credentials genuinely may not
 * open. A visible-but-dead control invites the operator to keep trying it.
 */

/**
 * Live is the expected state, so it stays neutral — a green badge that is green 99%
 * of the time is furniture. Only a degraded or refused feed spends colour.
 */
const CONNECTION_TONE: Record<string, 'idle' | 'warn' | 'critical'> = {
  live: 'idle',
  connecting: 'warn',
  offline: 'warn',
  rejected: 'critical',
  idle: 'idle',
};

const CONNECTION_LABEL: Record<string, string> = {
  live: 'Live',
  connecting: 'Connecting',
  offline: 'Reconnecting',
  rejected: 'Feed rejected',
  idle: 'Idle',
};

export function TopBar({ onRefresh }: { onRefresh: () => void }) {
  const connection = useSessionStore((s) => s.connection);
  const signOut = useSessionStore((s) => s.signOut);
  const label = useSessionStore((s) => s.label);
  const { role, identity } = usePermissions();

  const tone = CONNECTION_TONE[connection] ?? 'idle';
  const nav = ROUTES.filter((route) => mayAccess(route, identity.permissions));

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="shield" size={17} />
        </span>
        <span className="brand-name">Sentinel</span>
      </div>

      <nav className="nav" aria-label="Sections">
        {nav.map((route) => (
          <NavLink
            key={route.path}
            to={route.path}
            end={route.path === '/'}
            className={({ isActive }) => `nav-item ${isActive ? 'is-active' : ''}`}
            title={route.label}
          >
            {({ isActive }) => (
              <>
                <Icon name={route.icon} size={16} />
                {/* Only the current section spends the horizontal space on a label. */}
                {isActive && <span className="nav-label">{route.label}</span>}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="topbar-right">
        {/* The feed's health belongs in the chrome: if it is down, everything below is
            stale, and that matters more than any single panel. Green when healthy is
            the exception to the colour rule — a live indicator that never shows life
            is not an indicator. */}
        <span
          className={`status status-${connection === 'live' ? 'ok' : tone}`}
          title={`Live feed: ${connection}`}
        >
          <span className="status-dot" />
          {CONNECTION_LABEL[connection] ?? connection}
        </span>

        <IconButton icon="refresh" label="Refresh data" onClick={onRefresh} />

        <button className="user" onClick={signOut} title="Sign out">
          <span className="avatar">{(label || role).slice(0, 2).toUpperCase()}</span>
          <span className="user-text">
            {/* The name is what the operator typed, so it is shown as their label but
                the role underneath is the part the hub actually verified. */}
            <span className="user-name">{label || 'Signed in'}</span>
            <span className="user-role">{role}</span>
          </span>
          <Icon name="logout" size={15} />
        </button>
      </div>
    </header>
  );
}
