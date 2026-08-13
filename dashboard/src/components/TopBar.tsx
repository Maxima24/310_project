import { Icon, IconButton, type IconName } from './ui';
import { usePermissions } from '../lib/permissions';
import { useSessionStore } from '../stores/session.store';

/**
 * Application shell header.
 *
 * The nav is a single pill group with the active item expanded to show its label —
 * icons alone are ambiguous, labels alone are wide, and this gets both without a
 * tooltip. Sections beyond the overview are not built yet, so they are rendered
 * disabled rather than as links that go nowhere.
 */
const NAV: Array<{ id: string; icon: IconName; label: string; ready: boolean }> = [
  { id: 'overview', icon: 'home', label: 'Overview', ready: true },
  { id: 'cameras', icon: 'camera', label: 'Cameras', ready: false },
  { id: 'events', icon: 'chart', label: 'Reports', ready: false },
  { id: 'settings', icon: 'settings', label: 'Settings', ready: false },
];

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
  const { role } = usePermissions();

  const tone = CONNECTION_TONE[connection] ?? 'idle';

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="shield" size={17} />
        </span>
        <span className="brand-name">Sentinel</span>
      </div>

      <nav className="nav" aria-label="Sections">
        {NAV.map((item) => (
          <button
            key={item.id}
            className="nav-item"
            aria-current={item.id === 'overview' ? 'page' : undefined}
            disabled={!item.ready}
            title={item.ready ? item.label : `${item.label} — not built yet`}
          >
            <Icon name={item.icon} size={16} />
            {item.id === 'overview' && <span className="nav-label">{item.label}</span>}
          </button>
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
          <span className="avatar">{role.slice(0, 2).toUpperCase()}</span>
          <span className="user-text">
            <span className="user-name">Signed in</span>
            <span className="user-role">{role}</span>
          </span>
          <Icon name="logout" size={15} />
        </button>
      </div>
    </header>
  );
}
