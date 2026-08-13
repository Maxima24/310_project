import {
  SYSTEM_MODES,
  SystemMode,
  type AlertView,
  type SystemModeResponse,
} from '@cpe310/contracts';

import { Icon, Pill } from './ui';
import { ApiError } from '../lib/api';
import { evaluateModeChange, usePermissions } from '../lib/permissions';
import { useSetMode } from '../lib/queries';

const DESCRIPTION: Record<SystemMode, string> = {
  disarmed: 'Sensors report. Nothing alerts except a silent agent.',
  home: 'Interior motion ignored, doors still guarded.',
  away: 'Any sensor activity is an intrusion.',
};

/**
 * The arm state, and the only control that changes it.
 *
 * Given its own band with a state-coloured left edge because it is the most
 * consequential action on the page: an operator should be able to tell whether the
 * building is armed from across a room.
 */
export function ModeControl({
  mode,
  alerts,
}: {
  mode: SystemModeResponse | null;
  alerts: AlertView[];
}) {
  const { identity, canArm } = usePermissions();
  const setMode = useSetMode();

  const current = mode?.mode;
  const openCritical = alerts.filter((a) => a.severity === 'critical' && !a.acknowledged);
  const unacknowledged = alerts.filter((a) => !a.acknowledged);

  return (
    <section className={`command command-${current ?? 'disarmed'}`}>
      <div className="command-state">
        <span className="label">System</span>
        <span className="command-value">{current ?? '—'}</span>
        {current && <span className="command-hint">{DESCRIPTION[current]}</span>}
      </div>

      {canArm ? (
        <div className="segmented" role="group" aria-label="Arm state">
          {SYSTEM_MODES.map((option) => {
            // The hub's policy, evaluated before the click, so a refusal can be
            // explained on the control instead of arriving as a 403 afterwards.
            const decision = evaluateModeChange(identity, option, alerts);
            const isCurrent = option === current;
            const blocked = !decision.allowed;

            return (
              <button
                key={option}
                className={`segment ${blocked ? 'segment-locked' : ''}`}
                aria-pressed={isCurrent}
                disabled={isCurrent || blocked || setMode.isPending}
                title={blocked ? decision.reason : DESCRIPTION[option]}
                onClick={() => setMode.mutate(option)}
              >
                {blocked && <Icon name="lock" size={12} />}
                {option}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="command-hint">Read-only credential — arm state is shown, not editable.</p>
      )}

      <div className="command-meta">
        {openCritical.length > 0 ? (
          <Pill tone="critical" dot>
            {openCritical.length} critical
          </Pill>
        ) : unacknowledged.length > 0 ? (
          <Pill tone="warn" dot>
            {unacknowledged.length} open
          </Pill>
        ) : (
          <Pill tone="ok" dot>
            All clear
          </Pill>
        )}
      </div>

      {/* A refusal that got past the client-side check. The hub is authoritative and
          may know about alerts this client has not loaded. */}
      {setMode.isError && (
        <p className="command-note command-note-error">
          {setMode.error instanceof ApiError ? setMode.error.message : 'Could not change mode.'}
          {setMode.error instanceof ApiError && setMode.error.requiresRole && (
            <> Requires the {setMode.error.requiresRole} role.</>
          )}
        </p>
      )}

      {canArm && openCritical.length > 0 && !setMode.isError && (
        <p className="command-note">
          Disarming is locked while {openCritical.length} critical alert
          {openCritical.length === 1 ? ' is' : 's are'} unacknowledged. Acknowledge to unlock, or
          sign in as an admin to override.
        </p>
      )}
    </section>
  );
}
