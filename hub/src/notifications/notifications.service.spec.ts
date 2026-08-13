import {
  AlertSeverity,
  AlertType,
  NotificationChannel,
  NotificationStatus,
  SystemMode,
  type AlertView,
} from '@cpe310/contracts';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { ALERT_CHANNELS } from './channels/channels.token';
import type { AlertChannel } from './channels/channel.interface';
import { NotificationsService } from './notifications.service';

const MAX_ATTEMPTS = 3;

function alertView(over: Partial<AlertView> = {}): AlertView {
  return {
    id: 'alert-1',
    type: AlertType.IntrusionMotion,
    severity: AlertSeverity.Critical,
    message: 'Motion detected at Hallway',
    agentId: 'motion-hallway',
    eventId: 'event-1',
    modeAtTrigger: SystemMode.Away,
    acknowledged: false,
    acknowledgedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** A channel whose configuration, threshold, and behaviour are all controllable. */
function fakeChannel(
  name: AlertChannel['name'],
  opts: { configured?: boolean; min?: AlertSeverity; fail?: boolean } = {},
): AlertChannel & { send: jest.Mock } {
  const send = jest.fn(() =>
    opts.fail ? Promise.reject(new Error('delivery failed')) : Promise.resolve(),
  );
  return {
    name,
    isConfigured: () => opts.configured ?? true,
    minSeverity: () => opts.min ?? AlertSeverity.Info,
    send,
  };
}

async function buildService(channels: AlertChannel[], dueRows: unknown[] = []) {
  const prisma = {
    notification: {
      upsert: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue(dueRows),
    },
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'notifications.maxAttempts') return MAX_ATTEMPTS;
      if (key === 'notifications.retryCron') return '*/30 * * * * *';
      return undefined;
    }),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      NotificationsService,
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: config },
      { provide: SchedulerRegistry, useValue: { addCronJob: jest.fn() } },
      { provide: ALERT_CHANNELS, useValue: channels },
    ],
  }).compile();

  return { service: moduleRef.get(NotificationsService), prisma };
}

/** Extracts the status recorded for a given channel. */
function statusFor(prisma: { notification: { upsert: jest.Mock } }, channel: string) {
  const call = prisma.notification.upsert.mock.calls.find(
    (c) => c[0].where.alertId_channel.channel === channel,
  );
  return call?.[0].update;
}

describe('NotificationsService.dispatch', () => {
  it('delivers through every configured channel', async () => {
    const email = fakeChannel(NotificationChannel.Email);
    const webhook = fakeChannel(NotificationChannel.Webhook);
    const { service } = await buildService([email, webhook]);

    await service.dispatch(alertView());

    expect(email.send).toHaveBeenCalledTimes(1);
    expect(webhook.send).toHaveBeenCalledTimes(1);
  });

  it('skips an unconfigured channel without recording a failure', async () => {
    // An unset SMTP_HOST should mean "no email", not a failed delivery per alert.
    const email = fakeChannel(NotificationChannel.Email, { configured: false });
    const { service, prisma } = await buildService([email]);

    await service.dispatch(alertView());

    expect(email.send).not.toHaveBeenCalled();
    expect(prisma.notification.upsert).not.toHaveBeenCalled();
  });

  it('records a below-threshold alert as skipped rather than dropping it', async () => {
    // "Below threshold" must be distinguishable from "never attempted" after an incident.
    const email = fakeChannel(NotificationChannel.Email, { min: AlertSeverity.Critical });
    const { service, prisma } = await buildService([email]);

    await service.dispatch(alertView({ severity: AlertSeverity.Info }));

    expect(email.send).not.toHaveBeenCalled();
    expect(statusFor(prisma, NotificationChannel.Email).status).toBe(NotificationStatus.Skipped);
  });

  it('delivers when severity exactly meets the threshold', async () => {
    const email = fakeChannel(NotificationChannel.Email, { min: AlertSeverity.Warning });
    const { service } = await buildService([email]);

    await service.dispatch(alertView({ severity: AlertSeverity.Warning }));

    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('records a successful delivery with a timestamp', async () => {
    const email = fakeChannel(NotificationChannel.Email);
    const { service, prisma } = await buildService([email]);

    await service.dispatch(alertView());

    const update = statusFor(prisma, NotificationChannel.Email);
    expect(update.status).toBe(NotificationStatus.Sent);
    expect(update.attempts).toBe(1);
    expect(update.deliveredAt).toBeInstanceOf(Date);
  });

  it('keeps a failure pending with a backoff so it can be retried', async () => {
    const webhook = fakeChannel(NotificationChannel.Webhook, { fail: true });
    const { service, prisma } = await buildService([webhook]);

    await service.dispatch(alertView());

    const update = statusFor(prisma, NotificationChannel.Webhook);
    expect(update.status).toBe(NotificationStatus.Pending);
    expect(update.nextAttemptAt).toBeInstanceOf(Date);
    expect(update.error).toContain('delivery failed');
  });

  it('lets one broken channel not prevent the others', async () => {
    // A dead webhook must not stop the email that would actually wake someone.
    const webhook = fakeChannel(NotificationChannel.Webhook, { fail: true });
    const email = fakeChannel(NotificationChannel.Email);
    const { service } = await buildService([webhook, email]);

    await service.dispatch(alertView());

    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('is idempotent per (alert, channel)', async () => {
    // The unique index means a retry racing a fresh dispatch cannot create two rows.
    const email = fakeChannel(NotificationChannel.Email);
    const { service, prisma } = await buildService([email]);

    await service.dispatch(alertView());

    expect(prisma.notification.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { alertId_channel: { alertId: 'alert-1', channel: NotificationChannel.Email } },
      }),
    );
  });

  it('survives a bookkeeping failure, since the message may already have been sent', async () => {
    const email = fakeChannel(NotificationChannel.Email);
    const { service, prisma } = await buildService([email]);
    prisma.notification.upsert.mockRejectedValue(new Error('db down'));

    await expect(service.dispatch(alertView())).resolves.toBeUndefined();
    expect(email.send).toHaveBeenCalledTimes(1);
  });
});

describe('NotificationsService.retryPending', () => {
  const dueRow = {
    id: 'notif-1',
    alertId: 'alert-1',
    channel: NotificationChannel.Webhook,
    attempts: 1,
    alert: {
      id: 'alert-1',
      type: AlertType.IntrusionMotion,
      severity: AlertSeverity.Critical,
      message: 'Motion detected at Hallway',
      agentId: 'motion-hallway',
      eventId: null,
      modeAtTrigger: SystemMode.Away,
      acknowledged: false,
      acknowledgedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  };

  it('retries a due delivery and records success', async () => {
    const webhook = fakeChannel(NotificationChannel.Webhook);
    const { service, prisma } = await buildService([webhook], [dueRow]);

    await service.retryPending();

    expect(webhook.send).toHaveBeenCalledTimes(1);
    const update = statusFor(prisma, NotificationChannel.Webhook);
    expect(update.status).toBe(NotificationStatus.Sent);
    // Continues the attempt count rather than restarting it.
    expect(update.attempts).toBe(2);
  });

  it('gives up once the attempt cap is reached', async () => {
    const webhook = fakeChannel(NotificationChannel.Webhook, { fail: true });
    const { service, prisma } = await buildService(
      [webhook],
      [{ ...dueRow, attempts: MAX_ATTEMPTS - 1 }],
    );

    await service.retryPending();

    const update = statusFor(prisma, NotificationChannel.Webhook);
    expect(update.status).toBe(NotificationStatus.Failed);
    // Terminal, so the retry sweep stops picking it up.
    expect(update.nextAttemptAt).toBeNull();
  });

  it('fails a row whose channel is no longer configured instead of leaving it pending forever', async () => {
    const webhook = fakeChannel(NotificationChannel.Webhook, { configured: false });
    const { service, prisma } = await buildService([webhook], [dueRow]);

    await service.retryPending();

    const update = statusFor(prisma, NotificationChannel.Webhook);
    expect(update.status).toBe(NotificationStatus.Failed);
    expect(update.error).toMatch(/no longer configured/);
  });

  it('only picks up rows whose backoff has elapsed', async () => {
    const webhook = fakeChannel(NotificationChannel.Webhook);
    const { service, prisma } = await buildService([webhook], []);

    await service.retryPending();

    const where = prisma.notification.findMany.mock.calls[0][0].where;
    expect(where.status).toBe(NotificationStatus.Pending);
    expect(where.nextAttemptAt.lte).toBeInstanceOf(Date);
  });

  it('survives a database error so the scheduled job lives to the next tick', async () => {
    const webhook = fakeChannel(NotificationChannel.Webhook);
    const { service, prisma } = await buildService([webhook], []);
    prisma.notification.findMany.mockRejectedValue(new Error('connection reset'));

    await expect(service.retryPending()).resolves.toBeUndefined();
    expect(webhook.send).not.toHaveBeenCalled();
  });
});
