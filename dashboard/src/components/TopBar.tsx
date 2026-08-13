import { usePermissions } from '../lib/permissions';
import { useSessionStore } from '../stores/session.store';

const CONNECTION_LABEL: Record<string, string> = {
  idle: 'idle',
  connecting: 'connecting',
  live: 'live',
  rejected: 'feed rejected',
  offline: 'reconnecting',
};

export function TopBar() {
  const connection = useSessionStore((s) => s.connection);
  const signOut = useSessionStore((s) => s.signOut);
  const { role, zones, isZoneRestricted } = usePermissions();

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className={`brand-dot dot-${connection}`} aria-hidden="true" />
          <h1>Security Hub</h1>
          {/* The role is always visible: an operator should never have to guess why a
              control is missing. */}
          <span className={`role-chip role-${role}`}>{role}</span>
        </div>

        <div className="topbar-right">
          <span className={`conn conn-${connection}`}>
            {CONNECTION_LABEL[connection] ?? connection}
          </span>
          <button className="link-button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      {isZoneRestricted && (
        <div className="banner banner-info">
          Zone-restricted credential — showing only {zones.join(', ')}. Agents, events, and
          alerts elsewhere in the building are filtered out by the hub, not merely hidden here.
        </div>
      )}

      {connection === 'rejected' && (
        <div className="banner banner-error">
          The hub refused this credential for the live feed. Data shown may be stale — sign out
          and re-enter it.
        </div>
      )}
    </>
  );
}
