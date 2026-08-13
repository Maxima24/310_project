import {
  SYSTEM_MODES,
  SystemMode,
  type AlertView,
  type SystemModeResponse,
} from '@cpe310/contracts';

import { ApiError } from '../lib/api';
import { evaluateModeChange, usePermissions } from '../lib/permissions';
import { useSetMode } from '../lib/queries';

const DESCRIPTION: Record<SystemMode, string> = {
  disarmed: 'Sensors report; nothing alerts except a silent agent.',
  home: 'Interior motion ignored, doors still guarded.',
  away: 'Any sensor activity is an intrusion.',
};

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
    <section className={`mode mode-${current ?? 'unknown'}`}>
      <div className="mode-state">
        <span className="mode-label">System</span>
        <strong className="mode-value">{current ?? '…'}</strong>
        {current && <span className="mode-hint">{DESCRIPTION[current]}</span>}
      </div>

      {canArm ? (
        <div className="mode-buttons" role="group" aria-label="Arm state">
          {SYSTEM_MODES.map((option) => {
            // The same policy the hub enforces, evaluated up front so the reason can be
            // shown on the control rather than arriving as a 403 after the click.
            const decision = evaluateModeChange(identity, option, alerts);
            const isCurrent = option === current;
            const blocked = !decision.allowed;

            return (
              <button
                key={option}
                className={[
                  'mode-btn',
                  isCurrent ? 'mode-btn-active' : '',
                  blocked ? 'mode-btn-blocked' : '',
                ]
                  .join(' ')
                  .trim()}
                disabled={isCurrent || blocked || setMode.isPending}
                // Explains *why* on hover, which a plain disabled button never does.
                title={blocked ? decision.reason : DESCRIPTION[option]}
                onClick={() => setMode.mutate(option)}
              >
                {option}
                {blocked && (
                  <span className="lock" aria-hidden="true">
                    🔒
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="muted mode-readonly">
          Read-only credential — arm state is shown but cannot be changed.
        </p>
      )}

      <div className="mode-counts">
        {openCritical.length > 0 ? (
          <span className="pill pill-critical">{openCritical.length} critical</span>
        ) : unacknowledged.length > 0 ? (
          <span className="pill pill-warning">{unacknowledged.length} open</span>
        ) : (
          <span className="pill pill-ok">all clear</span>
        )}
      </div>

      {/* A refusal that got past the client-side check — the hub is authoritative and
          may know about alerts this client has not loaded. */}
      {setMode.isError && (
        <p className="mode-error">
          {setMode.error instanceof ApiError ? setMode.error.message : 'Could not change mode.'}
          {setMode.error instanceof ApiError && setMode.error.requiresRole && (
            <> Requires the {setMode.error.requiresRole} role.</>
          )}
        </p>
      )}

      {/* Explains the padlocks without needing a hover, which matters on a wall display. */}
      {canArm && openCritical.length > 0 && (
        <p className="mode-note">
          Disarming is locked while {openCritical.length} critical alert
          {openCritical.length === 1 ? ' is' : 's are'} unacknowledged. Acknowledge to unlock, or
          sign in as an admin to override.
        </p>
      )}
    </section>
  );
}
