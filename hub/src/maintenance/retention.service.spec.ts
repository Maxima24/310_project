import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';

import { BrowserCameraService } from '../cameras/browser-camera.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { MAX_ROLLUP_HOURS_PER_SWEEP, RetentionService, startOfHour } from './retention.service';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Mid-hour deliberately, so hour truncation is actually exercised. */
const NOW = new Date('2026-08-13T12:34:56.000Z');

interface Options {
  eventDays?: number;
  alertDays?: number;
  notificationDays?: number;
  auditDays?: number;
  batchSize?: number;
  maxBatches?: number;
  /** Newest hour already in EventRollup, or null for a database that has never rolled up. */
  watermark?: Date | null;
  oldestEvent?: Date | null;
  /** Rows each successive DELETE returns, per table. Defaults to one empty batch. */
  deletes?: Partial<Record<'Event' | 'Alert' | 'Notification' | 'AuditLog', number[]>>;
  failWith?: Error;
}

interface RawCall {
  sql: string;
  values: unknown[];
}

function which(
  sql: string,
): 'rollup' | 'Event' | 'Alert' | 'Notification' | 'AuditLog' | 'other' {
  if (sql.includes('INSERT INTO "EventRollup"')) return 'rollup';
  if (sql.includes('DELETE FROM "Event"')) return 'Event';
  if (sql.includes('DELETE FROM "Alert"')) return 'Alert';
  if (sql.includes('DELETE FROM "Notification"')) return 'Notification';
  if (sql.includes('DELETE FROM "AuditLog"')) return 'AuditLog';
  return 'other';
}

async function buildService(options: Options = {}) {
  const {
    eventDays = 0,
    alertDays = 0,
    notificationDays = 0,
    auditDays = 0,
    batchSize = 1_000,
    maxBatches = 50,
    watermark = null,
    oldestEvent = null,
    deletes = {},
    failWith,
  } = options;

  const calls: RawCall[] = [];
  const remaining: Record<string, number[]> = {
    Event: [...(deletes.Event ?? [])],
    Alert: [...(deletes.Alert ?? [])],
    Notification: [...(deletes.Notification ?? [])],
    AuditLog: [...(deletes.AuditLog ?? [])],
  };

  const executeRaw = jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(' ? ').replace(/\s+/g, ' ').trim();
    calls.push({ sql, values });

    if (failWith) return Promise.reject(failWith);

    const target = which(sql);
    if (target === 'rollup') return Promise.resolve(3);
    // An empty queue means the predicate matched nothing, which is what ends batching.
    return Promise.resolve(remaining[target]?.shift() ?? 0);
  });

  const prisma = {
    $executeRaw: executeRaw,
    $queryRaw: jest.fn().mockResolvedValue([{ hour: watermark }]),
    event: {
      findFirst: jest
        .fn()
        .mockResolvedValue(oldestEvent ? { createdAt: oldestEvent } : null),
    },
  };

  const config = {
    get: jest.fn((key: string) => {
      switch (key) {
        case 'retention.sweepCron':
          return '0 30 3 * * *';
        case 'retention.eventDays':
          return eventDays;
        case 'retention.alertDays':
          return alertDays;
        case 'retention.notificationDays':
          return notificationDays;
        case 'retention.auditDays':
          return auditDays;
        case 'retention.batchSize':
          return batchSize;
        case 'retention.maxBatches':
          return maxBatches;
        // Zero so batching never parks the test on a real timer.
        case 'retention.batchPauseMs':
          return 0;
        default:
          return undefined;
      }
    }),
  };

  const browserCameras = { reapEndedSessions: jest.fn().mockResolvedValue(0) };

  const moduleRef = await Test.createTestingModule({
    providers: [
      RetentionService,
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: config },
      { provide: SchedulerRegistry, useValue: new SchedulerRegistry() },
      { provide: BrowserCameraService, useValue: browserCameras },
    ],
  }).compile();

  const service = moduleRef.get(RetentionService);

  return {
    service,
    prisma,
    browserCameras,
    callsFor: (target: ReturnType<typeof which>) => calls.filter((c) => which(c.sql) === target),
  };
}

describe('startOfHour', () => {
  it('truncates to the containing UTC hour', () => {
    expect(startOfHour(NOW).toISOString()).toBe('2026-08-13T12:00:00.000Z');
  });

  it('leaves an exact hour alone, so a bucket key is stable', () => {
    const exact = new Date('2026-08-13T12:00:00.000Z');
    expect(startOfHour(exact).getTime()).toBe(exact.getTime());
  });
});

describe('RetentionService rollups', () => {
  it('never counts the current hour, which is still filling', async () => {
    const { service, callsFor } = await buildService({
      watermark: new Date('2026-08-13T09:00:00.000Z'),
    });

    await service.run(NOW);

    // Bounds are [10:00, 12:00): resumes after the watermark, stops before the open hour.
    const [rollup] = callsFor('rollup');
    expect(rollup.values[0]).toEqual(new Date('2026-08-13T10:00:00.000Z'));
    expect(rollup.values[1]).toEqual(new Date('2026-08-13T12:00:00.000Z'));
  });

  it('resumes from the newest bucket on record rather than a stored cursor', async () => {
    // Self-describing: restore the table from a backup and the next sweep picks up
    // exactly where the data says it should.
    const { service, callsFor } = await buildService({
      watermark: new Date('2026-08-01T00:00:00.000Z'),
      oldestEvent: new Date('2020-01-01T00:00:00.000Z'),
    });

    await service.run(NOW);

    expect(callsFor('rollup')[0].values[0]).toEqual(new Date('2026-08-01T01:00:00.000Z'));
  });

  it('starts from the oldest event when nothing has ever been rolled up', async () => {
    const { service, callsFor } = await buildService({
      watermark: null,
      oldestEvent: new Date('2026-08-13T07:42:10.000Z'),
    });

    await service.run(NOW);

    expect(callsFor('rollup')[0].values[0]).toEqual(new Date('2026-08-13T07:00:00.000Z'));
  });

  it('does nothing on an empty events table instead of scanning from epoch', async () => {
    const { service, callsFor } = await buildService({ watermark: null, oldestEvent: null });

    const result = await service.run(NOW);

    expect(callsFor('rollup')).toHaveLength(0);
    expect(result.rolledUpBuckets).toBe(0);
  });

  it('skips the write entirely when already caught up', async () => {
    const { service, callsFor } = await buildService({
      watermark: new Date('2026-08-13T11:00:00.000Z'),
    });

    const result = await service.run(NOW);

    expect(callsFor('rollup')).toHaveLength(0);
    expect(result.moreRemaining).toBe(false);
  });

  it('bounds one sweep so the first run cannot group the whole table at once', async () => {
    const { service, callsFor } = await buildService({
      watermark: null,
      oldestEvent: new Date('2020-01-01T00:00:00.000Z'),
    });

    const result = await service.run(NOW);

    const [rollup] = callsFor('rollup');
    const from = rollup.values[0] as Date;
    const to = rollup.values[1] as Date;
    expect(to.getTime() - from.getTime()).toBe(MAX_ROLLUP_HOURS_PER_SWEEP * HOUR_MS);
    // The caller must be told the backlog is not finished.
    expect(result.moreRemaining).toBe(true);
  });

  it('upserts rather than adds, so a retried sweep does not double a bucket', async () => {
    const { service, callsFor } = await buildService({
      watermark: new Date('2026-08-13T09:00:00.000Z'),
    });

    await service.run(NOW);

    expect(callsFor('rollup')[0].sql).toContain(
      'ON CONFLICT ("hour", "agentId", "type") DO UPDATE SET "count" = EXCLUDED."count"',
    );
  });
});

describe('RetentionService default windows', () => {
  it('deletes nothing at all when every window is 0', async () => {
    // The upgrade-safety property: installing this service must not silently start
    // destroying a year of evidence.
    const { service, callsFor } = await buildService({
      watermark: new Date('2026-08-13T09:00:00.000Z'),
    });

    const result = await service.run(NOW);

    expect(callsFor('Event')).toHaveLength(0);
    expect(callsFor('Alert')).toHaveLength(0);
    expect(callsFor('Notification')).toHaveLength(0);
    expect(callsFor('AuditLog')).toHaveLength(0);
    expect(result.eventsDeleted).toBe(0);
    // Rollups still ran, so history is being summarised before anyone opts into deletion.
    expect(result.rolledUpBuckets).toBeGreaterThan(0);
  });
});

describe('RetentionService event pruning', () => {
  it('cuts off at now minus the window when rollups are current', async () => {
    const { service, callsFor } = await buildService({
      eventDays: 30,
      watermark: new Date('2026-08-13T09:00:00.000Z'),
    });

    await service.run(NOW);

    expect(callsFor('Event')[0].values[0]).toEqual(new Date(NOW.getTime() - 30 * DAY_MS));
  });

  it('holds the cutoff at the rollup watermark when rollups are behind', async () => {
    // The invariant: an event is never deleted before its hour has been counted.
    // Without this, a backlogged rollup would let the prune erase history uncounted.
    const { service, callsFor } = await buildService({
      eventDays: 1,
      watermark: null,
      oldestEvent: new Date('2020-01-01T00:00:00.000Z'),
    });

    await service.run(NOW);

    const rolledThrough = new Date(
      Date.UTC(2020, 0, 1) + MAX_ROLLUP_HOURS_PER_SWEEP * HOUR_MS,
    );
    expect(callsFor('Event')[0].values[0]).toEqual(rolledThrough);
    // Which is far earlier than the window alone would have allowed.
    expect(rolledThrough.getTime()).toBeLessThan(NOW.getTime() - DAY_MS);
  });
});

describe('RetentionService alert pruning', () => {
  it('never deletes an unacknowledged alert, at any age', async () => {
    // An open alert is unfinished business. Ageing one out silently closes an incident
    // nobody handled, which is the exact outcome this system exists to prevent.
    const { service, callsFor } = await buildService({
      alertDays: 1,
      watermark: new Date('2026-08-13T09:00:00.000Z'),
    });

    await service.run(NOW);

    expect(callsFor('Alert')[0].sql).toContain('"acknowledged" = true');
  });

  it('applies the configured window', async () => {
    const { service, callsFor } = await buildService({
      alertDays: 90,
      watermark: new Date('2026-08-13T09:00:00.000Z'),
    });

    await service.run(NOW);

    expect(callsFor('Alert')[0].values[0]).toEqual(new Date(NOW.getTime() - 90 * DAY_MS));
  });
});

describe('RetentionService notification pruning', () => {
  it('leaves pending notifications alone — that queue is the retry worker’s', async () => {
    // Deleting a pending row decides, silently, that nobody needs to be told.
    const { service, callsFor } = await buildService({
      notificationDays: 30,
      watermark: new Date('2026-08-13T09:00:00.000Z'),
    });

    await service.run(NOW);

    expect(callsFor('Notification')[0].sql).toContain('"status" <> \'pending\'');
  });
});

describe('RetentionService browser-session reaping', () => {
  it('reaps ended sessions even with every retention window at 0', async () => {
    // Deliberately not behind a window: the windows decide how long EVIDENCE is kept, and
    // an ended browser session is not evidence — it is a row that can no longer publish
    // and would otherwise sit on the camera wall forever.
    const { service, browserCameras } = await buildService({
      watermark: new Date('2026-08-13T09:00:00.000Z'),
    });

    await service.run(NOW);

    expect(browserCameras.reapEndedSessions).toHaveBeenCalledWith(NOW);
  });

  it('reports how many it removed', async () => {
    const { service, browserCameras } = await buildService({
      watermark: new Date('2026-08-13T09:00:00.000Z'),
    });
    browserCameras.reapEndedSessions.mockResolvedValue(3);

    const result = await service.run(NOW);

    expect(result.browserSessionsReaped).toBe(3);
  });
});

describe('RetentionService audit pruning', () => {
  it('leaves the trail alone by default', async () => {
    const { service, callsFor } = await buildService({
      watermark: new Date('2026-08-13T09:00:00.000Z'),
    });

    await service.run(NOW);

    expect(callsFor('AuditLog')).toHaveLength(0);
  });

  it('prunes on `at`, the column the trail is ordered by', async () => {
    const { service, callsFor } = await buildService({
      auditDays: 365,
      watermark: new Date('2026-08-13T09:00:00.000Z'),
    });

    await service.run(NOW);

    expect(callsFor('AuditLog')[0].sql).toContain('"at" <');
    expect(callsFor('AuditLog')[0].values[0]).toEqual(new Date(NOW.getTime() - 365 * DAY_MS));
  });

  it('reports what it deleted', async () => {
    const { service } = await buildService({
      auditDays: 365,
      batchSize: 100,
      watermark: new Date('2026-08-13T09:00:00.000Z'),
      deletes: { AuditLog: [100, 25] },
    });

    const result = await service.run(NOW);

    expect(result.auditDeleted).toBe(125);
  });
});

describe('RetentionService batching', () => {
  it('keeps going while batches come back full', async () => {
    const { service, callsFor } = await buildService({
      eventDays: 30,
      batchSize: 100,
      watermark: new Date('2026-08-13T09:00:00.000Z'),
      deletes: { Event: [100, 100, 40] },
    });

    const result = await service.run(NOW);

    expect(callsFor('Event')).toHaveLength(3);
    expect(result.eventsDeleted).toBe(240);
  });

  it('stops on a short batch, which is how it knows the predicate is exhausted', async () => {
    const { service, callsFor } = await buildService({
      eventDays: 30,
      batchSize: 100,
      watermark: new Date('2026-08-13T09:00:00.000Z'),
      deletes: { Event: [40] },
    });

    await service.run(NOW);

    expect(callsFor('Event')).toHaveLength(1);
  });

  it('stops at the batch cap and reports that work remains', async () => {
    // A huge first prune drains over successive nights rather than competing with
    // ingestion for hours on one.
    const { service, callsFor } = await buildService({
      eventDays: 30,
      batchSize: 100,
      maxBatches: 3,
      watermark: new Date('2026-08-13T09:00:00.000Z'),
      deletes: { Event: [100, 100, 100, 100, 100] },
    });

    const result = await service.run(NOW);

    expect(callsFor('Event')).toHaveLength(3);
    expect(result.eventsDeleted).toBe(300);
    expect(result.moreRemaining).toBe(true);
  });

  it('deletes by id from a limited subquery rather than one unbounded statement', async () => {
    // An unbounded DELETE holds a long lock, and on this system that means sensor
    // events are refused while housekeeping runs.
    const { service, callsFor } = await buildService({
      eventDays: 30,
      watermark: new Date('2026-08-13T09:00:00.000Z'),
      deletes: { Event: [10] },
    });

    await service.run(NOW);

    expect(callsFor('Event')[0].sql).toMatch(/DELETE FROM "Event" WHERE "id" IN \( SELECT "id"/);
    expect(callsFor('Event')[0].sql).toContain('LIMIT');
  });
});

describe('RetentionService sweep', () => {
  it('swallows a failure so the cron job survives to try again', async () => {
    const { service } = await buildService({
      watermark: new Date('2026-08-13T09:00:00.000Z'),
      failWith: new Error('deadlock detected'),
    });

    await expect(service.sweep()).resolves.toBeNull();
  });

  it('skips a tick rather than overlapping a sweep still in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { service, prisma } = await buildService({
      watermark: new Date('2026-08-13T09:00:00.000Z'),
    });
    prisma.$queryRaw.mockImplementation(async () => {
      await gate;
      return [{ hour: new Date('2026-08-13T09:00:00.000Z') }];
    });

    const first = service.sweep();
    const second = await service.sweep();

    expect(second).toBeNull();
    release();
    await first;
  });
});
