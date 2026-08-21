import type {
  AlertSeverity,
  DailyActivity,
  EventType,
  ReportsSummary,
} from '@cpe310/contracts';
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../common/prisma/prisma.service';
import { isValidTimezone } from '../schedules/local-time';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Rows Postgres returns from the grouped queries below. */
interface DayCount {
  day: string;
  count: bigint | number;
}

interface KeyCount {
  key: string;
  count: bigint | number;
}

const toNumber = (value: bigint | number): number => Number(value);

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aggregates a window of history.
   *
   * THE OVERLAP RULE. Rollups cover every hour strictly before `boundary`; raw events
   * cover everything from `boundary` onward. Both sources are still present for rolled
   * hours while retention is off, so counting them together without this split would
   * silently double every historical number.
   */
  async summary(days: number, timezone: string): Promise<ReportsSummary> {
    const zone = isValidTimezone(timezone) ? timezone : 'UTC';
    const now = new Date();
    const since = new Date(now.getTime() - days * DAY_MS);

    const [watermark] = await this.prisma.$queryRaw<{ hour: Date | null }[]>`
      SELECT MAX("hour") AS hour FROM "EventRollup"
    `;
    // Exclusive upper bound of counted history.
    const boundary = watermark?.hour ? new Date(watermark.hour.getTime() + HOUR_MS) : new Date(0);

    const [rolledDaily, rawDaily, alertDaily, byAgent, byType, bySeverity, alertTotals] =
      await Promise.all([
        this.rolledDaily(since, boundary, zone),
        this.rawDaily(since, boundary, zone),
        this.alertDaily(since, zone),
        this.eventsByAgent(since, boundary),
        this.eventsByType(since, boundary),
        this.alertsBySeverity(since),
        this.alertTotals(since),
      ]);

    const daily = this.mergeDaily(since, days, zone, [rolledDaily, rawDaily], alertDaily);

    return {
      since: since.toISOString(),
      days,
      timezone: zone,
      rolledThrough: watermark?.hour ? boundary.toISOString() : null,
      daily,
      byAgent: byAgent.map((row) => ({ agentId: row.key, events: toNumber(row.count) })),
      byType: byType.map((row) => ({ type: row.key as EventType, events: toNumber(row.count) })),
      bySeverity: bySeverity.map((row) => ({
        severity: row.key as AlertSeverity,
        alerts: toNumber(row.count),
      })),
      totals: {
        events: daily.reduce((sum, day) => sum + day.events, 0),
        ...alertTotals,
      },
    };
  }

  /**
   * Counted hours, summed into local days.
   *
   * `"hour" AT TIME ZONE 'UTC' AT TIME ZONE $zone` reads the stored naive timestamp as
   * UTC and then renders it in the requested zone — without both halves, a day boundary
   * lands wherever the server happens to be, and "yesterday" means different things to
   * the operator and the chart.
   */
  private rolledDaily(since: Date, boundary: Date, zone: string): Promise<DayCount[]> {
    return this.prisma.$queryRaw<DayCount[]>`
      SELECT to_char(date_trunc('day', "hour" AT TIME ZONE 'UTC' AT TIME ZONE ${zone}), 'YYYY-MM-DD') AS day,
             SUM("count")::bigint AS count
      FROM "EventRollup"
      WHERE "hour" >= ${since} AND "hour" < ${boundary}
      GROUP BY 1
    `;
  }

  private rawDaily(since: Date, boundary: Date, zone: string): Promise<DayCount[]> {
    return this.prisma.$queryRaw<DayCount[]>`
      SELECT to_char(date_trunc('day', "createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${zone}), 'YYYY-MM-DD') AS day,
             COUNT(*)::bigint AS count
      FROM "Event"
      WHERE "createdAt" >= GREATEST(${since}, ${boundary})
      GROUP BY 1
    `;
  }

  private alertDaily(since: Date, zone: string): Promise<DayCount[]> {
    // Alerts have no rollup: they are two orders of magnitude rarer than events, so
    // summarising them would cost a table to save nothing.
    return this.prisma.$queryRaw<DayCount[]>`
      SELECT to_char(date_trunc('day', "createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${zone}), 'YYYY-MM-DD') AS day,
             COUNT(*)::bigint AS count
      FROM "Alert"
      WHERE "createdAt" >= ${since}
      GROUP BY 1
    `;
  }

  private eventsByAgent(since: Date, boundary: Date): Promise<KeyCount[]> {
    return this.prisma.$queryRaw<KeyCount[]>`
      SELECT key, SUM(count)::bigint AS count FROM (
        SELECT "agentId" AS key, SUM("count") AS count
        FROM "EventRollup" WHERE "hour" >= ${since} AND "hour" < ${boundary}
        GROUP BY 1
        UNION ALL
        SELECT "agentId" AS key, COUNT(*) AS count
        FROM "Event" WHERE "createdAt" >= GREATEST(${since}, ${boundary})
        GROUP BY 1
      ) merged
      GROUP BY key ORDER BY count DESC
    `;
  }

  private eventsByType(since: Date, boundary: Date): Promise<KeyCount[]> {
    return this.prisma.$queryRaw<KeyCount[]>`
      SELECT key, SUM(count)::bigint AS count FROM (
        SELECT "type"::text AS key, SUM("count") AS count
        FROM "EventRollup" WHERE "hour" >= ${since} AND "hour" < ${boundary}
        GROUP BY 1
        UNION ALL
        SELECT "type"::text AS key, COUNT(*) AS count
        FROM "Event" WHERE "createdAt" >= GREATEST(${since}, ${boundary})
        GROUP BY 1
      ) merged
      GROUP BY key ORDER BY count DESC
    `;
  }

  private alertsBySeverity(since: Date): Promise<KeyCount[]> {
    return this.prisma.$queryRaw<KeyCount[]>`
      SELECT "severity"::text AS key, COUNT(*)::bigint AS count
      FROM "Alert" WHERE "createdAt" >= ${since}
      GROUP BY 1
    `;
  }

  /** Alert side only — the event total is summed from the merged daily series, which
   *  has already resolved the rollup/raw overlap and needs no second pair of queries. */
  private async alertTotals(since: Date) {
    const [alerts, unacknowledged] = await Promise.all([
      this.prisma.alert.count({ where: { createdAt: { gte: since } } }),
      this.prisma.alert.count({ where: { createdAt: { gte: since }, acknowledged: false } }),
    ]);

    return { alerts, unacknowledged };
  }

  /**
   * Fills the window day by day.
   *
   * Empty days are emitted as zeroes rather than omitted: a gap in a chart reads as
   * "no data recorded", which on a security dashboard is a different and much more
   * alarming claim than "nothing happened".
   */
  private mergeDaily(
    since: Date,
    days: number,
    zone: string,
    eventSources: DayCount[][],
    alertRows: DayCount[],
  ): DailyActivity[] {
    const events = new Map<string, number>();
    for (const rows of eventSources) {
      for (const row of rows) {
        events.set(row.day, (events.get(row.day) ?? 0) + toNumber(row.count));
      }
    }

    const alerts = new Map(alertRows.map((row) => [row.day, toNumber(row.count)]));
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    const series: DailyActivity[] = [];
    for (let offset = 0; offset <= days; offset += 1) {
      // en-CA renders as YYYY-MM-DD, matching to_char above.
      const date = formatter.format(new Date(since.getTime() + offset * DAY_MS));
      if (series.some((entry) => entry.date === date)) continue;

      series.push({
        date,
        events: events.get(date) ?? 0,
        alerts: alerts.get(date) ?? 0,
      });
    }

    return series;
  }
}
