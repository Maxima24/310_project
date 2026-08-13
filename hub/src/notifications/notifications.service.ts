import {
  NotificationStatus,
  type AlertView,
  type NotificationChannel as ChannelName,
  type NotificationView,
} from '@cpe310/contracts';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Notification, Prisma } from '@prisma/client';
import { CronJob } from 'cron';

import { PrismaService } from '../common/prisma/prisma.service';
import { ALERT_CHANNELS } from './channels/channels.token';
import { meetsThreshold, type AlertChannel } from './channels/channel.interface';

const RETRY_JOB = 'notification-retry';

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
    @Inject(ALERT_CHANNELS) private readonly channels: AlertChannel[],
  ) {}

  onModuleInit(): void {
    const active = this.channels.filter((c) => c.isConfigured());
    this.logger.log(
      `Notification channels active: ${
        active.map((c) => `${c.name}(>=${c.minSeverity()})`).join(', ') || 'none'
      }`,
    );

    const cron = this.config.get<string>('notifications.retryCron') ?? '*/30 * * * * *';
    const job = new CronJob(cron, () => void this.retryPending());
    this.scheduler.addCronJob(RETRY_JOB, job);
    job.start();
  }

  private get maxAttempts(): number {
    return this.config.get<number>('notifications.maxAttempts') ?? 5;
  }

  /**
   * Fan an alert out to every configured channel.
   *
   * Deliberately not awaited by the caller: event ingestion must not wait on an SMTP
   * handshake. Each channel is attempted independently so a broken webhook cannot
   * prevent the email, and every attempt is recorded so an operator can answer "was
   * anyone actually told?" — an alarm that silently failed to notify is
   * indistinguishable from one that never fired.
   */
  async dispatch(alert: AlertView): Promise<void> {
    for (const channel of this.channels) {
      if (!channel.isConfigured()) continue;

      if (!meetsThreshold(alert.severity, channel.minSeverity())) {
        // Recorded rather than dropped, so "below threshold" is distinguishable from
        // "never attempted" later.
        await this.record(alert.id, channel.name, {
          status: NotificationStatus.Skipped,
          error: `severity ${alert.severity} below ${channel.name} threshold ${channel.minSeverity()}`,
        });
        continue;
      }

      await this.attempt(alert, channel, 0);
    }
  }

  /** One delivery attempt, persisting the outcome. */
  private async attempt(alert: AlertView, channel: AlertChannel, priorAttempts: number): Promise<void> {
    const attempts = priorAttempts + 1;

    try {
      await channel.send(alert);
      await this.record(alert.id, channel.name, {
        status: NotificationStatus.Sent,
        attempts,
        deliveredAt: new Date(),
        error: null,
        nextAttemptAt: null,
      });
    } catch (error) {
      const message = (error as Error).message;
      const exhausted = attempts >= this.maxAttempts;

      await this.record(alert.id, channel.name, {
        status: exhausted ? NotificationStatus.Failed : NotificationStatus.Pending,
        attempts,
        error: message.slice(0, 500),
        nextAttemptAt: exhausted ? null : new Date(Date.now() + this.backoffMs(attempts)),
      });

      this.logger[exhausted ? 'error' : 'warn'](
        `${channel.name} delivery of ${alert.id} failed (attempt ${attempts}/${this.maxAttempts})` +
          `${exhausted ? ' — giving up' : ', will retry'}: ${message}`,
      );
    }
  }

  /**
   * Exponential backoff with a ceiling. A receiver that is down for an hour should be
   * retried occasionally, not hammered every 30 seconds.
   */
  private backoffMs(attempts: number): number {
    return Math.min(15 * 60_000, 30_000 * 2 ** (attempts - 1));
  }

  /**
   * Upsert on (alertId, channel), which the unique index enforces. Idempotent, so a
   * retry racing a fresh dispatch cannot produce two rows for one delivery.
   */
  private async record(
    alertId: string,
    channel: ChannelName,
    data: Partial<Prisma.NotificationUncheckedCreateInput>,
  ): Promise<void> {
    try {
      await this.prisma.notification.upsert({
        where: { alertId_channel: { alertId, channel } },
        create: { alertId, channel, ...data } as Prisma.NotificationUncheckedCreateInput,
        update: data,
      });
    } catch (error) {
      // Bookkeeping must never break delivery — the notification may well have been
      // sent successfully.
      this.logger.error(
        `Could not record ${channel} notification for ${alertId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Retries deliveries whose backoff has elapsed. Scheduled, rather than an in-memory
   * timer, so pending retries survive a hub restart — a notification queued in memory
   * would silently vanish on redeploy.
   */
  async retryPending(): Promise<void> {
    let due: (Notification & { alert: unknown })[];

    try {
      due = await this.prisma.notification.findMany({
        where: {
          status: NotificationStatus.Pending,
          nextAttemptAt: { lte: new Date() },
        },
        include: { alert: true },
        take: 25,
      });
    } catch (error) {
      this.logger.error(`Notification retry sweep failed: ${(error as Error).message}`);
      return;
    }

    for (const row of due) {
      const channel = this.channels.find((c) => c.name === row.channel);
      if (!channel || !channel.isConfigured()) {
        // The channel was removed or unconfigured since the attempt was queued;
        // leaving it Pending forever would be a lie.
        await this.record(row.alertId, row.channel, {
          status: NotificationStatus.Failed,
          error: 'channel is no longer configured',
          nextAttemptAt: null,
        });
        continue;
      }

      await this.attempt(toAlertView(row.alert), channel, row.attempts);
    }
  }

  async findForAlert(alertId: string): Promise<NotificationView[]> {
    const rows = await this.prisma.notification.findMany({
      where: { alertId },
      orderBy: { channel: 'asc' },
    });
    return rows.map(toNotificationView);
  }

  async findMany(limit = 50): Promise<NotificationView[]> {
    const rows = await this.prisma.notification.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toNotificationView);
  }
}

function toNotificationView(row: Notification): NotificationView {
  return {
    id: row.id,
    alertId: row.alertId,
    channel: row.channel,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
  };
}

/** Minimal Alert row -> AlertView for a retry, which only needs rendering fields. */
function toAlertView(alert: unknown): AlertView {
  const a = alert as Record<string, unknown>;
  return {
    id: String(a.id),
    type: a.type as AlertView['type'],
    severity: a.severity as AlertView['severity'],
    message: String(a.message),
    agentId: (a.agentId as string | null) ?? null,
    eventId: (a.eventId as string | null) ?? null,
    modeAtTrigger: a.modeAtTrigger as AlertView['modeAtTrigger'],
    acknowledged: Boolean(a.acknowledged),
    acknowledgedAt: a.acknowledgedAt ? (a.acknowledgedAt as Date).toISOString() : null,
    createdAt: (a.createdAt as Date).toISOString(),
  };
}
