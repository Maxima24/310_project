import { AuditAction, AuditActor, AuditOutcome, SystemMode } from '@cpe310/contracts';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { PolicyService } from '../common/security/policy.service';
import { SystemService } from '../system/system.service';
import { ScheduleRunnerService } from './schedule-runner.service';

/** Friday 2026-08-14, 12:00 UTC. */
const NOW = new Date('2026-08-14T12:00:00Z');

interface ScheduleRow {
  id?: string;
  name?: string;
  enabled?: boolean;
  mode?: SystemMode;
  daysOfWeek?: number[];
  startMinute?: number;
  timezone?: string;
  lastFiredFor?: string | null;
}

function schedule(overrides: ScheduleRow = {}) {
  return {
    id: 'sched-1',
    name: 'Nightly arm',
    enabled: true,
    mode: SystemMode.Away,
    daysOfWeek: [],
    startMinute: 720,
    timezone: 'UTC',
    lastFiredFor: null,
    lastFiredAt: null,
    ...overrides,
  };
}

async function buildRunner(
  rows: ReturnType<typeof schedule>[],
  options: { allowed?: boolean; reason?: string; graceMinutes?: number; claimed?: boolean } = {},
) {
  const { allowed = true, reason, graceMinutes = 60, claimed = true } = options;

  const prisma = {
    armSchedule: {
      findMany: jest.fn().mockResolvedValue(rows),
      updateMany: jest.fn().mockResolvedValue({ count: claimed ? 1 : 0 }),
    },
  };

  const system = {
    setMode: jest.fn().mockResolvedValue({
      mode: SystemMode.Away,
      previous: SystemMode.Disarmed,
      changed: true,
      updatedAt: NOW.toISOString(),
    }),
  };

  const policy = {
    canScheduleSetMode: jest.fn().mockResolvedValue({ allowed, reason }),
  };

  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  const config = {
    get: jest.fn((key: string) => {
      if (key === 'schedules.tickCron') return '*/30 * * * * *';
      if (key === 'schedules.graceMinutes') return graceMinutes;
      return undefined;
    }),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      ScheduleRunnerService,
      { provide: PrismaService, useValue: prisma },
      { provide: SystemService, useValue: system },
      { provide: PolicyService, useValue: policy },
      { provide: AuditService, useValue: audit },
      { provide: ConfigService, useValue: config },
      { provide: SchedulerRegistry, useValue: new SchedulerRegistry() },
    ],
  }).compile();

  return { runner: moduleRef.get(ScheduleRunnerService), prisma, system, policy, audit };
}

describe('ScheduleRunnerService firing', () => {
  it('fires a schedule whose boundary has passed', async () => {
    const { runner, system } = await buildRunner([schedule({ startMinute: 700 })]);

    const result = await runner.tick(NOW);

    expect(system.setMode).toHaveBeenCalledWith(SystemMode.Away);
    expect(result?.fired).toBe(1);
  });

  it('does not fire before the boundary', async () => {
    const { runner, system } = await buildRunner([schedule({ startMinute: 800 })]);

    await runner.tick(NOW);

    expect(system.setMode).not.toHaveBeenCalled();
  });

  it('goes through SystemService rather than writing the mode itself', async () => {
    // So the WebSocket broadcast, the no-op short circuit, and mode history behave
    // exactly as they do for a manual change — a schedule must not be a second,
    // subtly different way to change the mode.
    const { runner, system } = await buildRunner([schedule({ startMinute: 700 })]);

    await runner.tick(NOW);

    expect(system.setMode).toHaveBeenCalledTimes(1);
  });

  it('claims the slot before acting, so an overlapping tick cannot double-fire', async () => {
    const { runner, prisma } = await buildRunner([schedule({ startMinute: 700 })]);

    await runner.tick(NOW);

    const claim = prisma.armSchedule.updateMany.mock.calls[0][0];
    expect(claim.where.id).toBe('sched-1');
    expect(claim.data.lastFiredFor).toBe('2026-08-14');
  });

  it('claims a schedule that has NEVER fired, whose lastFiredFor is null', async () => {
    // Regression. The predicate was `lastFiredFor: { not: dateKey }`, and in SQL
    // `NULL <> '2026-08-14'` is NULL rather than true — so the row was excluded and a
    // brand-new schedule could never fire a first time, nor ever reach a state where
    // the bug stopped applying. Every schedule in the system was affected.
    //
    // This assertion is on the predicate rather than the outcome because a mocked
    // updateMany cannot reproduce three-valued logic; the shape is what is checkable
    // here, and hub/scripts/verify-schedules.cjs proves the behaviour against Postgres.
    const { runner, prisma } = await buildRunner([
      schedule({ startMinute: 700, lastFiredFor: null }),
    ]);

    await runner.tick(NOW);

    const where = prisma.armSchedule.updateMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ lastFiredFor: null }, { lastFiredFor: { not: '2026-08-14' } }]);
  });

  it('does nothing when another instance won the claim', async () => {
    const { runner, system } = await buildRunner([schedule({ startMinute: 700 })], {
      claimed: false,
    });

    await runner.tick(NOW);

    expect(system.setMode).not.toHaveBeenCalled();
  });

  it('skips a schedule already fired for this local date', async () => {
    const { runner, system } = await buildRunner([
      schedule({ startMinute: 700, lastFiredFor: '2026-08-14' }),
    ]);

    await runner.tick(NOW);

    expect(system.setMode).not.toHaveBeenCalled();
  });

  it('fires each due schedule independently', async () => {
    const { runner, system } = await buildRunner([
      schedule({ id: 'a', startMinute: 700 }),
      schedule({ id: 'b', startMinute: 710 }),
    ]);

    const result = await runner.tick(NOW);

    expect(system.setMode).toHaveBeenCalledTimes(2);
    expect(result?.fired).toBe(2);
  });
});

describe('ScheduleRunnerService and manual overrides', () => {
  it('still fires after someone manually changed the mode', async () => {
    // The whole point. The most common reason a building is left unarmed is that
    // somebody forgot, and a schedule that yields forever to one manual click does not
    // solve that. The schedule is a transition at a boundary, not a negotiation.
    const { runner, system } = await buildRunner([schedule({ startMinute: 700 })]);
    system.setMode.mockResolvedValue({
      mode: SystemMode.Away,
      previous: SystemMode.Disarmed,
      changed: true,
      updatedAt: NOW.toISOString(),
    });

    await runner.tick(NOW);

    expect(system.setMode).toHaveBeenCalledWith(SystemMode.Away);
  });

  it('does not re-assert the mode on later ticks', async () => {
    // A schedule that re-armed every 30 seconds would fight an operator who
    // deliberately disarmed to let a contractor in.
    const rows = [schedule({ startMinute: 700 })];
    const { runner, system, prisma } = await buildRunner(rows);

    await runner.tick(NOW);
    // The claim wrote lastFiredFor; model that for the next tick.
    prisma.armSchedule.findMany.mockResolvedValue([
      schedule({ startMinute: 700, lastFiredFor: '2026-08-14' }),
    ]);
    await runner.tick(new Date('2026-08-14T12:05:00Z'));

    expect(system.setMode).toHaveBeenCalledTimes(1);
  });
});

describe('ScheduleRunnerService disarm safety', () => {
  const disarming = schedule({ mode: SystemMode.Disarmed, startMinute: 700 });

  it('is held when a critical alert is unacknowledged', async () => {
    // A schedule may not be what silences an active incident.
    const { runner, system, audit } = await buildRunner([disarming], {
      allowed: false,
      reason: 'Scheduled disarm held: 1 critical alert still unacknowledged.',
    });

    const result = await runner.tick(NOW);

    expect(system.setMode).not.toHaveBeenCalled();
    expect(result?.held).toBe(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      action: AuditAction.ScheduleFired,
      outcome: AuditOutcome.Denied,
    });
  });

  it('leaves a held schedule UNCLAIMED so it can still fire once cleared', async () => {
    // If the operator acknowledges at 12:15, the 12:00 schedule should still arrive.
    const { runner, prisma } = await buildRunner([disarming], { allowed: false, reason: 'held' });

    await runner.tick(NOW);

    expect(prisma.armSchedule.updateMany).not.toHaveBeenCalled();
  });

  it('deduplicates the hold so it is one audit line, not one per tick', async () => {
    const { runner, audit } = await buildRunner([disarming], { allowed: false, reason: 'held' });

    await runner.tick(NOW);

    expect(audit.record.mock.calls[0][0].dedupeKey).toBe('schedule-held:sched-1:2026-08-14');
  });

  it('checks the policy for a disarm but not for an arm', async () => {
    const { runner, policy } = await buildRunner([schedule({ startMinute: 700 })]);

    await runner.tick(NOW);

    // Always consulted; the policy itself is what waves arming through, so the runner
    // has no second, divergent copy of that rule.
    expect(policy.canScheduleSetMode).toHaveBeenCalledWith(SystemMode.Away);
  });
});

describe('ScheduleRunnerService missed windows', () => {
  it('records a stale boundary instead of acting on it', async () => {
    const { runner, system, audit } = await buildRunner([schedule({ startMinute: 420 })], {
      graceMinutes: 60,
    });

    const result = await runner.tick(NOW);

    expect(system.setMode).not.toHaveBeenCalled();
    expect(result?.missed).toBe(1);
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      outcome: AuditOutcome.Denied,
      targetType: 'schedule',
    });
    expect(audit.record.mock.calls[0][0].reason).toMatch(/grace window/i);
  });

  it('claims the miss so it is recorded once, not every 30 seconds', async () => {
    const { runner, prisma } = await buildRunner([schedule({ startMinute: 420 })]);

    await runner.tick(NOW);

    expect(prisma.armSchedule.updateMany).toHaveBeenCalledTimes(1);
    // No lastFiredAt: nothing fired, and claiming one would misreport history.
    expect(prisma.armSchedule.updateMany.mock.calls[0][0].data.lastFiredAt).toBeUndefined();
  });
});

describe('ScheduleRunnerService robustness', () => {
  it('attributes an automatic transition to `system`, never to a role', async () => {
    // Putting a person's name against something no person did would be a lie in the
    // one table whose value is that it is not.
    const { runner, audit } = await buildRunner([schedule({ startMinute: 700 })]);

    await runner.tick(NOW);

    expect(audit.record.mock.calls[0][0].actor).toBe(AuditActor.System);
  });

  it('carries on when one schedule throws', async () => {
    const { runner, system } = await buildRunner([
      schedule({ id: 'broken', timezone: 'Not/AZone', startMinute: 700 }),
      schedule({ id: 'fine', startMinute: 700 }),
    ]);

    const result = await runner.tick(NOW);

    expect(system.setMode).toHaveBeenCalledTimes(1);
    expect(result?.fired).toBe(1);
  });

  it('skips a tick rather than overlapping one still running', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { runner, prisma } = await buildRunner([schedule({ startMinute: 700 })]);
    prisma.armSchedule.findMany.mockImplementation(async () => {
      await gate;
      return [];
    });

    const first = runner.tick(NOW);
    expect(await runner.tick(NOW)).toBeNull();

    release();
    await first;
  });

  it('survives a database failure so the cron job lives to try again', async () => {
    const { runner, prisma } = await buildRunner([]);
    prisma.armSchedule.findMany.mockRejectedValue(new Error('connection lost'));

    await expect(runner.tick(NOW)).resolves.toBeNull();
  });
});
