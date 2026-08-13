import { AlertSeverity, NotificationChannel, type AlertView } from '@cpe310/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AlertChannel } from './channel.interface';

/**
 * Always-available fallback.
 *
 * Exists so a hub with no email or webhook configured still produces a delivery
 * record per alert. Without it, "no notifications were sent" and "notifications were
 * never configured" look identical in the database, which is exactly the ambiguity an
 * operator cannot afford after an incident.
 */
@Injectable()
export class LogChannel implements AlertChannel {
  readonly name = NotificationChannel.Log;

  private readonly logger = new Logger('AlertNotification');

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return true;
  }

  minSeverity(): AlertSeverity {
    return this.config.get<AlertSeverity>('notifications.log.minSeverity') ?? AlertSeverity.Info;
  }

  async send(alert: AlertView): Promise<void> {
    const line =
      `[${alert.severity.toUpperCase()}] ${alert.type} - ${alert.message} ` +
      `(agent=${alert.agentId ?? 'n/a'}, mode=${alert.modeAtTrigger}, id=${alert.id})`;

    if (alert.severity === AlertSeverity.Critical) this.logger.error(line);
    else if (alert.severity === AlertSeverity.Warning) this.logger.warn(line);
    else this.logger.log(line);

    return Promise.resolve();
  }
}
