import { AuditAction, AuditActor, AuditOutcome, SystemMode } from '@cpe310/contracts';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { ArmSchedule } from '@prisma/client';
import { CronJob } from 'cron';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { PolicyService } from '../common/security/policy.service';
import { SystemService } from '../system/system.service';
import { evaluateDue, localNow } from './local-time';

const TICK_JOB = 'arm-schedule-tick';

/** What one tick did, returned for tests. */
export interface TickResult {
  fired: number;
  held: number;
  missed: number;
}

/**
 * Fires schedules when their boundary passes.
 *
 * Three properties matter more than anything else here.
 *
 * IT FIRES ONCE. `lastFiredFor` holds the LOCAL date a schedule last acted on, and the
 * claim below is a conditional update on that column. An overlapping tick, a hub
 * restart mid-loop, or a second instance all lose the race rather than arming twice.
 *
 * IT USES LOCAL WALL TIME. An operator means "22:00 where the building is", not an
 * instant in UTC, so every comparison goes through the schedule's own IANA zone and
 * stays correct across a DST change that a stored offset would get an hour wrong.
 *
 * IT CANNOT SILENCE AN INCIDENT. A scheduled disarm obeys the same critical-alert rule
 * a human does, with no admin override — because the override exists so a named person
 * can take responsibility, and a cron job cannot.
 */
@Injectable()
export class ScheduleRunnerService implements OnModuleInit {
  private readonly logger = new Logger(ScheduleRunnerService.name);

  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly system: SystemService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const cron = this.config.get<string>('schedules.tickCron') ?? '*/30 * * * * *';
    const job = new CronJob(cron, () => {
      void this.tick();
    });

    this.scheduler.addCronJob(TICK_JOB, job);
    job.start();

    this.logger.log(
      `Arm-schedule evaluator running (${cron}); a boundary missed by more than ` +
        `${this.graceMinutes} minutes is recorded rather than acted on`,
    );
  }

  /**
   * How late a boundary may be and still fire.
   *
   * Exists for the hub-was-down case. Acting on a boundary hours after the fact is
   * worse than skipping it — disarming a building at 13:00 because a 07:00 schedule
   * was missed lowers protection at a time nobody chose — so beyond this it is recorded
   * as missed and left alone.
   */
  private get graceMinutes(): number {
    return this.config.get<number>('schedules.graceMinutes') ?? 60;
  }

  async tick(now = new Date()): Promise<TickResult | null> {
    if (this.ticking) return null;
    this.ticking = true;

    try {
      const schedules = await this.prisma.armSchedule.findMany({ where: { enabled: true } });
      const result: TickResult = { fired: 0, held: 0, missed: 0 };

      for (const schedule of schedules) {
        try {
          const outcome = await this.evaluate(schedule, now);
          if (outcome) result[outcome] += 1;
        } catch (error) {
          // One bad schedule — an unresolvable zone, say — must not stop the others.
          this.logger.error(
            `Schedule "${schedule.name}" (${schedule.id}) failed: ${(error as Error).message}`,
          );
        }
      }

      return result;
    } catch (error) {
      this.logger.error(`Arm-schedule tick failed: ${(error as Error).message}`);
      return null;
    } finally {
      this.ticking = false;
    }
  }

  private async evaluate(
    schedule: ArmSchedule,
    now: Date,
  ): Promise<'fired' | 'held' | 'missed' | null> {
    const local = localNow(now, schedule.timezone);
    const verdict = evaluateDue(schedule, local, this.graceMinutes);

    if (verdict.kind === 'idle') return null;

    if (verdict.kind === 'missed') {
      // Claimed so the miss is recorded once rather than every tick for the rest of
      // the day, and so tomorrow's boundary is unaffected.
      if (!(await this.claim(schedule.id, verdict.dateKey, null))) return null;

      const reason =
        `Boundary passed ${verdict.lateByMinutes} minutes ago, beyond the ` +
        `${this.graceMinutes}-minute grace window. The hub was probably not running. ` +
        'Acting now would change the mode at a time nobody chose.';

      this.logger.warn(`Schedule "${schedule.name}" missed its window: ${reason}`);
      await this.recordAudit(schedule, AuditOutcome.Denied, reason, verdict.dateKey, local);
      return 'missed';
    }

    // Policy BEFORE the claim: a held schedule must stay unclaimed so it can fire later
    // in the same window once an operator acknowledges the alert blocking it.
    const decision = await this.policy.canScheduleSetMode(schedule.mode as SystemMode);

    if (!decision.allowed) {
      this.logger.warn(`Schedule "${schedule.name}" held: ${decision.reason}`);
      await this.recordAudit(
        schedule,
        AuditOutcome.Denied,
        decision.reason,
        verdict.dateKey,
        local,
        // Deduped for the length of the retry window, so a hold that persists for an
        // hour is one line rather than one hundred and twenty.
        this.graceMinutes * 60_000,
      );
      return 'held';
    }

    if (!(await this.claim(schedule.id, verdict.dateKey, now))) return null;

    // Goes through SystemService so the WebSocket broadcast, the no-op short circuit,
    // and the mode history behave exactly as they do for a manual change. A schedule
    // must not be a second, subtly different way to change the mode.
    const change = await this.system.setMode(schedule.mode as SystemMode);

    this.logger.log(
      `Schedule "${schedule.name}" fired: ${change.previous} -> ${change.mode}` +
        (verdict.lateByMinutes > 0 ? ` (${verdict.lateByMinutes}m late)` : ''),
    );

    await this.recordAudit(schedule, AuditOutcome.Allowed, undefined, verdict.dateKey, local, 0, {
      from: change.previous,
      to: change.mode,
      changed: change.changed,
      lateByMinutes: verdict.lateByMinutes,
    });

    return 'fired';
  }

  /**
   * Takes ownership of this schedule's slot for this local date.
   *
   * The conditional update is the whole safety story: whoever writes the row first wins,
   * and every other caller sees a count of 0 and stops.
   *
   * The explicit null branch is NOT redundant. `lastFiredFor <> '2026-08-14'` evaluates
   * to NULL — not true — for a row where the column IS null, so a bare `not` predicate
   * silently excludes every schedule that has never fired. That is every new schedule,
   * which means none of them would ever fire a first time and none could reach the state
   * where the bug stops applying. Unit tests could not see it: they mock `updateMany` and
   * so cannot evaluate SQL three-valued logic. Live verification is what caught it.
   */
  private async claim(id: string, dateKey: string, firedAt: Date | null): Promise<boolean> {
    const claimed = await this.prisma.armSchedule.updateMany({
      where: {
        id,
        OR: [{ lastFiredFor: null }, { lastFiredFor: { not: dateKey } }],
      },
      data: { lastFiredFor: dateKey, ...(firedAt ? { lastFiredAt: firedAt } : {}) },
    });

    return claimed.count > 0;
  }

  private recordAudit(
    schedule: ArmSchedule,
    outcome: AuditOutcome,
    reason: string | undefined,
    dateKey: string,
    local: { minuteOfDay: number },
    dedupeWindowMs = 0,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    return this.audit.record({
      // `system`, never a role. Attributing an automatic transition to an operator
      // would put a person's name against something no person did.
      actor: AuditActor.System,
      action: AuditAction.ScheduleFired,
      outcome,
      reason,
      targetType: 'schedule',
      targetId: schedule.id,
      detail: {
        name: schedule.name,
        mode: schedule.mode,
        timezone: schedule.timezone,
        localDate: dateKey,
        localMinute: local.minuteOfDay,
        ...extra,
      },
      ...(dedupeWindowMs > 0
        ? { dedupeKey: `schedule-held:${schedule.id}:${dateKey}`, dedupeWindowMs }
        : {}),
    });
  }
}
