import {
  DAY_LABELS,
  SystemMode,
  describeDays,
  formatStartMinute,
  parseStartMinute,
  type ArmScheduleView,
  type UpsertArmScheduleRequest,
} from '@cpe310/contracts';
import { useState } from 'react';

import { Button, Empty, IconButton, Pill } from './ui';
import { usePermissions } from '../lib/permissions';
import { useDeleteSchedule, useSaveSchedule, useSchedules } from '../lib/queries';

const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * Schedules: the list and its editor.
 *
 * The copy here does a job the controls cannot. A schedule is a transition rather than
 * an enforced state, and that is genuinely surprising — an operator who assumes
 * otherwise will be confused the first time a manual disarm sticks past a scheduled
 * arm's boundary. So the panel says what it does in a sentence rather than leaving it
 * to be discovered.
 */
export function ScheduleEditor() {
  const { canArm, canDisarm, canWriteSchedules: canWrite } = usePermissions();
  const schedules = useSchedules();
  const remove = useDeleteSchedule();
  const [editing, setEditing] = useState<ArmScheduleView | 'new' | null>(null);

  const list = schedules.data ?? [];

  return (
    <>
      <div className="panel-head">
        <p className="field-hint">
          A schedule fires <strong>once</strong> when its time passes, then leaves the system
          alone. It will not fight a manual change — but the next boundary still arrives, because
          the usual reason a building is left unarmed is that somebody forgot.
        </p>
        {canWrite && (
          <Button icon="plus" size="sm" onClick={() => setEditing('new')}>
            Add schedule
          </Button>
        )}
      </div>

      {schedules.isPending && <Empty icon="clock">Loading schedules…</Empty>}

      {!schedules.isPending && list.length === 0 && !editing && (
        <Empty icon="clock">No schedules. Arming depends entirely on someone remembering.</Empty>
      )}

      {list.length > 0 && (
        <ul className="schedule-list">
          {list.map((schedule) => (
            <li className="schedule-row" key={schedule.id}>
              <span className="schedule-time">{formatStartMinute(schedule.startMinute)}</span>

              <span className="schedule-main">
                <span className="schedule-name">{schedule.name}</span>
                <span className="schedule-meta">
                  {describeDays(schedule.daysOfWeek)} · {schedule.timezone}
                  {schedule.lastFiredAt &&
                    ` · last fired ${new Date(schedule.lastFiredAt).toLocaleString()}`}
                </span>
              </span>

              <Pill tone={schedule.mode === SystemMode.Disarmed ? 'warn' : 'idle'}>
                {schedule.mode}
              </Pill>

              {/* Disabled is the exception worth marking; enabled is the norm and stays
                  neutral, per the colour rule. */}
              {!schedule.enabled && <Pill tone="warn">paused</Pill>}

              {canWrite && (
                <span className="schedule-actions">
                  <IconButton icon="settings" label="Edit" plain onClick={() => setEditing(schedule)} />
                  <IconButton
                    icon="trash"
                    label={`Delete "${schedule.name}"`}
                    plain
                    onClick={() => remove.mutate(schedule.id)}
                  />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <ScheduleForm
          schedule={editing === 'new' ? null : editing}
          canDisarm={canDisarm}
          canArm={canArm}
          onDone={() => setEditing(null)}
        />
      )}
    </>
  );
}

function ScheduleForm({
  schedule,
  canArm,
  canDisarm,
  onDone,
}: {
  schedule: ArmScheduleView | null;
  canArm: boolean;
  canDisarm: boolean;
  onDone: () => void;
}) {
  const save = useSaveSchedule();

  const [name, setName] = useState(schedule?.name ?? '');
  const [mode, setMode] = useState<SystemMode>(schedule?.mode ?? SystemMode.Away);
  const [time, setTime] = useState(formatStartMinute(schedule?.startMinute ?? 22 * 60));
  const [timezone, setTimezone] = useState(schedule?.timezone ?? BROWSER_ZONE);
  const [days, setDays] = useState<number[]>(schedule?.daysOfWeek ?? []);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);

  const startMinute = parseStartMinute(time);

  const submit = async (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    setError(null);

    if (startMinute === null) {
      setError('Enter a time as HH:MM.');
      return;
    }

    const input: UpsertArmScheduleRequest = {
      name: name.trim(),
      mode,
      startMinute,
      timezone,
      daysOfWeek: days,
      enabled,
    };

    try {
      await save.mutateAsync({ id: schedule?.id, input });
      onDone();
    } catch (err) {
      // The hub's refusals here are written for a human — an unknown time zone, or a
      // schedule exercising a permission the author lacks — so they are shown verbatim.
      setError(err instanceof Error ? err.message : 'Could not save the schedule.');
    }
  };

  return (
    <form className="schedule-form" onSubmit={submit}>
      <div className="schedule-form-grid">
        <div className="field">
          <label className="label" htmlFor="sched-name">
            Name
          </label>
          <input
            id="sched-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nightly arm"
            maxLength={80}
            autoFocus
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="sched-time">
            Time
          </label>
          <input
            id="sched-time"
            className="input"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="sched-mode">
            Set mode to
          </label>
          <select
            id="sched-mode"
            className="input"
            value={mode}
            onChange={(e) => setMode(e.target.value as SystemMode)}
          >
            {canArm && <option value={SystemMode.Away}>away</option>}
            {canArm && <option value={SystemMode.Home}>home</option>}
            {/* Omitted rather than shown-and-refused when the credential cannot disarm:
                a schedule cannot grant a permission its author lacks, and the hub says
                so if this is bypassed. */}
            {canDisarm && <option value={SystemMode.Disarmed}>disarmed</option>}
          </select>
        </div>

        <div className="field">
          <label className="label" htmlFor="sched-tz">
            Time zone
          </label>
          <input
            id="sched-tz"
            className="input"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="America/New_York"
          />
          <p className="field-hint">
            Stored per schedule so the time stays correct when the clocks change.
          </p>
        </div>
      </div>

      <div className="field">
        <span className="label">Days</span>
        <div className="day-picker">
          {DAY_LABELS.map((label, day) => (
            <button
              type="button"
              key={label}
              className={`day-chip ${days.includes(day) ? 'is-on' : ''}`}
              aria-pressed={days.includes(day)}
              onClick={() =>
                setDays((current) =>
                  current.includes(day)
                    ? current.filter((d) => d !== day)
                    : [...current, day].sort((a, b) => a - b),
                )
              }
            >
              {label}
            </button>
          ))}
        </div>
        <p className="field-hint">{describeDays(days)}</p>
      </div>

      <label className="checkline">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>

      {error && <p className="form-error">{error}</p>}

      <div className="schedule-form-actions">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={save.isPending || !name.trim()}>
          {save.isPending ? 'Saving…' : schedule ? 'Save changes' : 'Create schedule'}
        </Button>
      </div>
    </form>
  );
}
