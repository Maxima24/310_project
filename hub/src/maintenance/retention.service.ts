import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { BrowserCameraService } from '../cameras/browser-camera.service';
import { PrismaService } from '../common/prisma/prisma.service';

const SWEEP_JOB = 'retention-sweep';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Ceiling on how much history one sweep counts, in hours (90 days).
 *
 * Bounds the very first run, which would otherwise group the entire Event table in a
 * single statement. It is also what makes the prune clamp below real rather than
 * decorative: with a bound, rollups can genuinely lag the retention window, and the
 * prune has to wait for them.
 */
export const MAX_ROLLUP_HOURS_PER_SWEEP = 24 * 90;

/** What one sweep did. Returned for tests and logged as the operator-facing summary. */
export interface RetentionResult {
  /** (hour, agent, type) buckets written or refreshed. */
  rolledUpBuckets: number;
  /** Exclusive upper bound of raw event time that has now been counted. */
  rolledThrough: Date;
  eventsDeleted: number;
  alertsDeleted: number;
  notificationsDeleted: number;
  auditDeleted: number;
  /** Ended browser-camera sessions removed. Not governed by a retention window. */
  browserSessionsReaped: number;
  /** True if a cap stopped the sweep early, so more remains for the next run. */
  moreRemaining: boolean;
}

/** Truncates to the start of the containing UTC hour — the rollup bucket key. */
export function startOfHour(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

/**
 * Rolls history up, then deletes what has aged out.
 *
 * Nothing in this system deleted a row before this service existed, so Event, Alert,
 * and Notification grew forever. Two ideas do the work:
 *
 * ROLL UP FIRST. An hour of raw events becomes one counted row per (hour, agent, type)
 * — on observed data roughly a 16x reduction, and unlike a lossy encoding it answers
 * "how much activity, where, when" exactly. Rollups run on every sweep whether or not
 * deletion is configured, so the summary exists before it is ever needed and the
 * reporting views keep working on windows whose raw rows are long gone.
 *
 * DELETE ONLY WHAT IS COUNTED. The prune cutoff is clamped to the rollup watermark, so
 * an event is never deleted until its hour has been counted. Get this ordering wrong
 * and history does not shrink, it disappears.
 *
 * Every window defaults to 0 = keep forever. Upgrading must never silently start
 * deleting evidence; deletion is something an operator opts into.
 */
@Injectable()
export class RetentionService implements OnModuleInit {
  private readonly logger = new Logger(RetentionService.name);

  /** Guards against a long first prune overlapping the next scheduled tick. */
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
    private readonly browserCameras: BrowserCameraService,
  ) {}

  /**
   * Registered imperatively rather than with @Cron for the same reason as the liveness
   * sweep: the schedule comes from config, and a decorator argument cannot read it.
   */
  onModuleInit(): void {
    const cron = this.config.get<string>('retention.sweepCron') ?? '0 30 3 * * *';
    const job = new CronJob(cron, () => {
      void this.sweep();
    });

    this.scheduler.addCronJob(SWEEP_JOB, job);
    job.start();

    const windows = [
      ['events', this.days('eventDays')],
      ['alerts', this.days('alertDays')],
      ['notifications', this.days('notificationDays')],
      ['audit', this.days('auditDays')],
    ] as const;

    const configured = windows
      .filter(([, d]) => d > 0)
      .map(([name, d]) => `${name} ${d}d`)
      .join(', ');

    this.logger.log(
      `Retention sweep scheduled (${cron}); ` +
        (configured
          ? `pruning ${configured}`
          : 'all windows are 0, so nothing is deleted — rollups only'),
    );
  }

  private days(key: 'eventDays' | 'alertDays' | 'notificationDays' | 'auditDays'): number {
    return this.config.get<number>(`retention.${key}`) ?? 0;
  }

  private get batchSize(): number {
    return this.config.get<number>('retention.batchSize') ?? 1_000;
  }

  private get maxBatches(): number {
    return this.config.get<number>('retention.maxBatches') ?? 50;
  }

  private get batchPauseMs(): number {
    return this.config.get<number>('retention.batchPauseMs') ?? 100;
  }

  async sweep(): Promise<RetentionResult | null> {
    if (this.sweeping) {
      this.logger.warn('Previous retention sweep still running — skipping this tick');
      return null;
    }
    this.sweeping = true;

    const started = Date.now();

    try {
      const result = await this.run(new Date());

      const summary =
        `rolled up ${result.rolledUpBuckets} bucket(s), ` +
        `deleted ${result.eventsDeleted} event(s), ${result.alertsDeleted} alert(s), ` +
        `${result.notificationsDeleted} notification(s), ${result.auditDeleted} audit ` +
        `entr(ies), reaped ${result.browserSessionsReaped} browser session(s) ` +
        `in ${Date.now() - started}ms`;

      if (result.moreRemaining) {
        this.logger.warn(
          `Retention sweep hit its batch cap — ${summary}. More remains; the next run continues.`,
        );
      } else {
        this.logger.log(`Retention sweep complete: ${summary}`);
      }

      return result;
    } catch (error) {
      // A failed sweep must not kill the scheduled job. Deleting late is survivable;
      // never running again is not.
      this.logger.error(`Retention sweep failed: ${(error as Error).message}`);
      return null;
    } finally {
      this.sweeping = false;
    }
  }

  /** The sweep body, with `now` injected so tests do not depend on the wall clock. */
  async run(now: Date): Promise<RetentionResult> {
    const { buckets, rolledThrough, caughtUp } = await this.rollUpEvents(now);

    const events = await this.pruneEvents(now, rolledThrough);
    const alerts = await this.pruneAlerts(now);
    const notifications = await this.pruneNotifications(now);
    const audit = await this.pruneAudit(now);

    // Deliberately NOT behind a retention window. The windows above decide how long
    // EVIDENCE is kept, and an ended browser session is not evidence — it is a row that
    // can no longer publish anything and would otherwise sit on the camera wall forever.
    // Its events and audit entries are separate records and are governed by their own
    // windows, so nothing observable is lost by removing the agent.
    const browserSessionsReaped = await this.browserCameras.reapEndedSessions(now);

    return {
      rolledUpBuckets: buckets,
      rolledThrough,
      eventsDeleted: events.deleted,
      alertsDeleted: alerts.deleted,
      notificationsDeleted: notifications.deleted,
      auditDeleted: audit.deleted,
      browserSessionsReaped,
      moreRemaining:
        !caughtUp || events.capped || alerts.capped || notifications.capped || audit.capped,
    };
  }

  /**
   * Counts every complete hour that has not been counted yet.
   *
   * Only complete hours: the current hour is still receiving events, so counting it
   * would bake in a number that is wrong by the time anyone reads it.
   *
   * The watermark is `max(hour)` already in EventRollup rather than a stored cursor,
   * which means the rollup table is self-describing — restore it from a backup and the
   * next sweep picks up exactly where the data says it should. Safe because `createdAt`
   * is the hub's own insertion clock, so events never arrive for an hour already past.
   *
   * `ON CONFLICT DO UPDATE` makes a retry idempotent: recounting a bucket from the same
   * rows writes the same number, where adding would silently double it.
   */
  private async rollUpEvents(
    now: Date,
  ): Promise<{ buckets: number; rolledThrough: Date; caughtUp: boolean }> {
    const currentHour = startOfHour(now);

    const [watermark] = await this.prisma.$queryRaw<{ hour: Date | null }[]>`
      SELECT MAX("hour") AS hour FROM "EventRollup"
    `;

    // First ever run: start from the oldest event rather than the beginning of time,
    // so the scan is bounded by real data.
    let from = watermark?.hour ? new Date(watermark.hour.getTime() + HOUR_MS) : null;

    if (!from) {
      const oldest = await this.prisma.event.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      // No events at all: everything that exists is trivially counted.
      if (!oldest) return { buckets: 0, rolledThrough: currentHour, caughtUp: true };
      from = startOfHour(oldest.createdAt);
    }

    if (from >= currentHour) return { buckets: 0, rolledThrough: currentHour, caughtUp: true };

    // Stop at the current hour, which is still filling — counting it would bake in a
    // number that is already wrong by the time anyone reads it.
    const to = new Date(
      Math.min(from.getTime() + MAX_ROLLUP_HOURS_PER_SWEEP * HOUR_MS, currentHour.getTime()),
    );

    // `gen_random_uuid()::text` because the id column is text: Postgres will not cast
    // uuid to text on its own here.
    const buckets = await this.prisma.$executeRaw`
      INSERT INTO "EventRollup" ("id", "hour", "agentId", "type", "count")
      SELECT gen_random_uuid()::text,
             date_trunc('hour', "createdAt"),
             "agentId",
             "type",
             COUNT(*)::int
      FROM "Event"
      WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY date_trunc('hour', "createdAt"), "agentId", "type"
      ON CONFLICT ("hour", "agentId", "type") DO UPDATE SET "count" = EXCLUDED."count"
    `;

    const caughtUp = to.getTime() === currentHour.getTime();
    if (!caughtUp) {
      this.logger.warn(
        `Rollup is catching up on a backlog — counted through ${to.toISOString()}, ` +
          `${Math.round((currentHour.getTime() - to.getTime()) / DAY_MS)} day(s) still behind. ` +
          'Event pruning is held to this point until it catches up.',
      );
    }

    return { buckets, rolledThrough: to, caughtUp };
  }

  /**
   * Deletes events past the window, but never past what has been counted.
   *
   * `Alert.eventId` is `onDelete: SetNull`, so an alert outliving its event keeps its
   * own message and severity and simply loses the link. That is the right trade: the
   * judgement is the record worth keeping, and it was never a foreign-key-shaped fact.
   */
  private async pruneEvents(now: Date, rolledThrough: Date) {
    const days = this.days('eventDays');
    if (days <= 0) return { deleted: 0, capped: false };

    // The invariant that makes rollups meaningful rather than decorative: whichever of
    // the two bounds is earlier wins, so nothing is deleted before it has been counted.
    const cutoff = new Date(Math.min(now.getTime() - days * DAY_MS, rolledThrough.getTime()));

    return this.deleteInBatches(
      'Event',
      (limit) => this.prisma.$executeRaw`
        DELETE FROM "Event"
        WHERE "id" IN (
          SELECT "id" FROM "Event" WHERE "createdAt" < ${cutoff} LIMIT ${limit}
        )
      `,
    );
  }

  /**
   * Deletes acknowledged alerts past the window.
   *
   * An unacknowledged alert is never deleted, at any age. It is unfinished business,
   * and ageing one out would silently close an incident nobody ever looked at — the
   * one outcome this whole system exists to prevent. An alert that is still open after
   * the retention window is a process failure worth seeing, not a row worth reclaiming.
   */
  private async pruneAlerts(now: Date) {
    const days = this.days('alertDays');
    if (days <= 0) return { deleted: 0, capped: false };

    const cutoff = new Date(now.getTime() - days * DAY_MS);

    return this.deleteInBatches(
      'Alert',
      (limit) => this.prisma.$executeRaw`
        DELETE FROM "Alert"
        WHERE "id" IN (
          SELECT "id" FROM "Alert"
          WHERE "createdAt" < ${cutoff} AND "acknowledged" = true
          LIMIT ${limit}
        )
      `,
    );
  }

  /**
   * Deletes terminal notifications past the window.
   *
   * `pending` is excluded regardless of age because it is the retry worker's queue —
   * deleting one is deciding, silently, that nobody needs to be told. A pending
   * notification old enough to match this window means the retry worker is stuck, and
   * that is a bug to find rather than evidence to reclaim.
   *
   * Most rows here disappear on their own: Notification cascades from Alert.
   */
  private async pruneNotifications(now: Date) {
    const days = this.days('notificationDays');
    if (days <= 0) return { deleted: 0, capped: false };

    const cutoff = new Date(now.getTime() - days * DAY_MS);

    return this.deleteInBatches(
      'Notification',
      (limit) => this.prisma.$executeRaw`
        DELETE FROM "Notification"
        WHERE "id" IN (
          SELECT "id" FROM "Notification"
          WHERE "createdAt" < ${cutoff} AND "status" <> 'pending'
          LIMIT ${limit}
        )
      `,
    );
  }

  /**
   * Deletes audit entries past the window.
   *
   * No exemptions, unlike the tables above — but note this is the one window where a
   * short setting quietly destroys the feature. The trail's entire value is how far
   * back it reaches, and it is by far the smallest table here, so the storage saved is
   * negligible against what is lost.
   */
  private async pruneAudit(now: Date) {
    const days = this.days('auditDays');
    if (days <= 0) return { deleted: 0, capped: false };

    const cutoff = new Date(now.getTime() - days * DAY_MS);

    return this.deleteInBatches(
      'AuditLog',
      (limit) => this.prisma.$executeRaw`
        DELETE FROM "AuditLog"
        WHERE "id" IN (
          SELECT "id" FROM "AuditLog" WHERE "at" < ${cutoff} LIMIT ${limit}
        )
      `,
    );
  }

  /**
   * Runs a delete repeatedly until it stops matching rows or the batch cap is hit.
   *
   * Batching is the whole point. One unbounded `DELETE` over a million rows holds a
   * long lock, and on this system that means sensor events are refused while it runs —
   * housekeeping causing exactly the blind spot an intruder needs. Small statements
   * with a pause between them let ingestion interleave, and the cap means a huge first
   * prune drains over successive nights instead of competing for hours on one.
   */
  private async deleteInBatches(
    table: string,
    deleteBatch: (limit: number) => Promise<number>,
  ): Promise<{ deleted: number; capped: boolean }> {
    const limit = this.batchSize;
    const maxBatches = this.maxBatches;
    let deleted = 0;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const count = await deleteBatch(limit);
      deleted += count;

      // A short batch means the predicate is exhausted — nothing left to find.
      if (count < limit) return { deleted, capped: false };

      if (this.batchPauseMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.batchPauseMs));
      }
    }

    this.logger.warn(`${table}: stopped at the ${maxBatches}-batch cap with rows still matching`);
    return { deleted, capped: true };
  }
}
