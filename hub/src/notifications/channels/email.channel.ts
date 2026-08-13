import { AlertSeverity, NotificationChannel, type AlertView } from '@cpe310/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

import type { AlertChannel } from './channel.interface';

/**
 * Email delivery over SMTP (roadmap item 3).
 *
 * Points at Mailpit in compose, so the whole path is verifiable locally — a real
 * alert produces a real message in a real inbox. Switching to a production SMTP host
 * is env-only.
 */
@Injectable()
export class EmailChannel implements AlertChannel {
  readonly name = NotificationChannel.Email;

  private readonly logger = new Logger(EmailChannel.name);
  private transporter?: Transporter;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.host && this.to);
  }

  minSeverity(): AlertSeverity {
    return (
      this.config.get<AlertSeverity>('notifications.email.minSeverity') ?? AlertSeverity.Warning
    );
  }

  private get host(): string | undefined {
    return this.config.get<string>('notifications.email.host');
  }

  private get to(): string | undefined {
    return this.config.get<string>('notifications.email.to');
  }

  async send(alert: AlertView): Promise<void> {
    const transporter = this.getTransporter();

    await transporter.sendMail({
      from: this.config.get<string>('notifications.email.from') ?? 'security-hub@localhost',
      to: this.to,
      // Severity first so it is readable in a phone's notification preview, where
      // only the first few words survive. ASCII-only for the same reason the alert
      // messages are: these strings pass through mail clients, consoles, and
      // eventually SMS, where a stray em-dash renders as mojibake.
      subject: `[${alert.severity.toUpperCase()}] ${alert.type} - ${alert.message}`,
      text: this.renderText(alert),
    });

    this.logger.log(`Emailed ${alert.type} (${alert.id}) to ${this.to}`);
  }

  /**
   * Built on first use rather than in the constructor: an unconfigured channel must
   * not attempt an SMTP connection at boot, and DI runs before we know whether email
   * is enabled at all.
   */
  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;

    this.transporter = createTransport({
      host: this.host,
      port: this.config.get<number>('notifications.email.port') ?? 1025,
      // Mailpit and most dev SMTP servers are plaintext; a real host sets this true.
      secure: this.config.get<boolean>('notifications.email.secure') ?? false,
      ...(this.config.get<string>('notifications.email.user')
        ? {
            auth: {
              user: this.config.get<string>('notifications.email.user'),
              pass: this.config.get<string>('notifications.email.pass'),
            },
          }
        : {}),
    });

    return this.transporter;
  }

  private renderText(alert: AlertView): string {
    const lines = [
      alert.message,
      '',
      `Severity   : ${alert.severity}`,
      `Type       : ${alert.type}`,
      `Agent      : ${alert.agentId ?? 'n/a'}`,
      `System mode: ${alert.modeAtTrigger}`,
      `Raised at  : ${alert.createdAt}`,
      `Alert id   : ${alert.id}`,
    ];

    if (alert.type === 'agent_offline') {
      // Say why this matters, since "a sensor stopped reporting" reads as harmless
      // unless the reasoning is spelled out.
      lines.push(
        '',
        'A sensor that stops reporting is treated as possible tampering rather than a',
        'harmless disconnect. Check the device and its network link.',
      );
    }

    return lines.join('\n');
  }
}
