import {
  AuditAction,
  AuditOutcome,
  type AuditEntryView,
  type QueryAuditRequest,
} from '@cpe310/contracts';
import { useState } from 'react';

import { Empty, Icon, Pill } from './ui';
import { useAudit } from '../lib/queries';

/** Wire values read like identifiers; these read like sentences. */
const ACTION_LABELS: Record<string, string> = {
  [AuditAction.ModeChanged]: 'Mode changed',
  [AuditAction.AlertAcknowledged]: 'Alert acknowledged',
  [AuditAction.AgentEnrolled]: 'Agent enrolled',
  [AuditAction.AgentTokenRotated]: 'Agent token rotated',
  [AuditAction.CameraViewed]: 'Camera viewed',
  [AuditAction.ScheduleFired]: 'Schedule',
};

/**
 * The audit trail.
 *
 * The design problem here is honesty about identity. The hub knows the ROLE that acted,
 * because that comes from the credential. It does not know the PERSON, because
 * credentials are shared per role — so a name shown here is something the caller typed
 * about themselves. The role is rendered as the actor and the name is rendered as a
 * quoted claim beside it, never as the subject of the sentence, and the panel says why
 * once at the top. An interface that let a typed name read as identity would be worse
 * than one that showed no name at all.
 */
export function AuditTrail() {
  const [outcome, setOutcome] = useState<AuditOutcome | ''>('');
  const [action, setAction] = useState<AuditAction | ''>('');

  const query: QueryAuditRequest = {
    limit: 100,
    ...(outcome ? { outcome } : {}),
    ...(action ? { action } : {}),
  };

  const audit = useAudit(query, true);
  const entries = audit.data ?? [];

  return (
    <>
      <div className="panel-head">
        <p className="field-hint">
          Written by the hub as things happen; there is no way to add to it. Roles are verified
          from the credential — <strong>names are self-asserted and not checked</strong>, because
          credentials are shared per role.
        </p>

        <div className="filter-row">
          <select
            className="input input-sm"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as AuditOutcome | '')}
            aria-label="Filter by outcome"
          >
            <option value="">All outcomes</option>
            <option value={AuditOutcome.Denied}>Refused only</option>
            <option value={AuditOutcome.Allowed}>Allowed only</option>
          </select>

          <select
            className="input input-sm"
            value={action}
            onChange={(e) => setAction(e.target.value as AuditAction | '')}
            aria-label="Filter by action"
          >
            <option value="">All actions</option>
            {Object.values(AuditAction).map((value) => (
              <option key={value} value={value}>
                {ACTION_LABELS[value] ?? value}
              </option>
            ))}
          </select>
        </div>
      </div>

      {audit.isPending && <Empty icon="history">Loading the trail…</Empty>}

      {!audit.isPending && entries.length === 0 && (
        <Empty icon="history">Nothing recorded for this filter.</Empty>
      )}

      {entries.length > 0 && (
        <ul className="audit-list">
          {entries.map((entry) => (
            <AuditRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </>
  );
}

function AuditRow({ entry }: { entry: AuditEntryView }) {
  const refused = entry.outcome === AuditOutcome.Denied;

  return (
    <li className={`audit-row ${refused ? 'is-refused' : ''}`}>
      <span className="audit-when" title={new Date(entry.at).toLocaleString()}>
        {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        <span className="audit-date">{new Date(entry.at).toLocaleDateString()}</span>
      </span>

      <span className="audit-body">
        <span className="audit-headline">
          {/* Colour marks the exception. A refusal is the interesting line in this
              table; an allowed action is the norm and stays neutral. */}
          {refused && <Icon name="lock" size={13} />}
          <strong>{ACTION_LABELS[entry.action] ?? entry.action}</strong>
          {entry.targetId && <span className="audit-target">{entry.targetId}</span>}
        </span>

        <span className="audit-meta">
          <span className="audit-actor" title="Established by the hub from the credential">
            {entry.actorAgentId ?? entry.actor}
          </span>
          {entry.actorLabel && (
            <span
              className="audit-claim"
              title="Typed by whoever signed in. The hub cannot verify it."
            >
              claims “{entry.actorLabel}”
            </span>
          )}
          {entry.ip && <span className="audit-ip">{entry.ip}</span>}
        </span>

        {entry.reason && <span className="audit-reason">{entry.reason}</span>}
      </span>

      {refused && <Pill tone="critical">refused</Pill>}
    </li>
  );
}
