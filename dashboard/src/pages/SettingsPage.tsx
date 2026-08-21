import { AuditTrail } from '../components/AuditTrail';
import { ScheduleEditor } from '../components/ScheduleEditor';
import { Card } from '../components/ui';
import { usePermissions } from '../lib/permissions';

export function SettingsPage() {
  const { canReadAudit, canWriteSchedules, role } = usePermissions();

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Settings</h1>
        <span className="page-sub">Signed in as {role}</span>
      </div>

      <Card title="Scheduled arming" icon="clock">
        <ScheduleEditor />
      </Card>

      {canReadAudit ? (
        <Card title="Audit trail" icon="history" flush>
          <AuditTrail />
        </Card>
      ) : (
        /* Shown rather than omitted. An operator who cannot find the audit trail may
           conclude the system has none, which is a worse belief than knowing it exists
           and is not theirs to read. */
        <Card title="Audit trail" icon="history">
          <p className="field-hint">
            The hub records every mode change, acknowledgement, enrolment, and refusal. Reading it
            requires an admin credential — a trail readable by the people it records invites
            tidying, and its value is that it is written by the system rather than curated by its
            subjects.
          </p>
        </Card>
      )}

      <Card title="Retention" icon="settings">
        <p className="field-hint">
          Configured on the hub, not here — these windows decide what evidence is destroyed, so
          they belong with the deployment rather than behind a dashboard button.
        </p>
        <ul className="settings-facts">
          <li>
            <span>Events</span>
            <span>
              Summarised into hourly counts before deletion, so activity history survives the raw
              rows.
            </span>
          </li>
          <li>
            <span>Alerts</span>
            <span>
              Only <strong>acknowledged</strong> alerts are ever deleted. An open one is
              unfinished business at any age.
            </span>
          </li>
          <li>
            <span>Notifications</span>
            <span>
              Pending deliveries are never deleted — that queue belongs to the retry worker.
            </span>
          </li>
          <li>
            <span>Defaults</span>
            <span>
              Every window ships as <code>0</code>, meaning keep forever. Nothing is deleted until
              someone deliberately sets one.
            </span>
          </li>
        </ul>
      </Card>

      {!canWriteSchedules && (
        <p className="field-hint">
          This credential can read settings but not change them.
        </p>
      )}
    </>
  );
}
