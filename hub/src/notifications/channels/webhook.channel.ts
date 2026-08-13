import { AlertSeverity, NotificationChannel, type AlertView } from '@cpe310/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AlertChannel } from './channel.interface';

/**
 * Generic webhook delivery (roadmap item 3).
 *
 * The escape hatch: Slack, Discord, PagerDuty, n8n, or a homegrown script all accept
 * a JSON POST, so this covers most integrations without a dedicated channel each.
 */
@Injectable()
export class WebhookChannel implements AlertChannel {
  readonly name = NotificationChannel.Webhook;

  private readonly logger = new Logger(WebhookChannel.name);

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.url);
  }

  minSeverity(): AlertSeverity {
    return (
      this.config.get<AlertSeverity>('notifications.webhook.minSeverity') ?? AlertSeverity.Warning
    );
  }

  private get url(): string | undefined {
    return this.config.get<string>('notifications.webhook.url');
  }

  async send(alert: AlertView): Promise<void> {
    const url = this.url;
    if (!url) throw new Error('webhook URL is not configured');

    const timeoutMs = this.config.get<number>('notifications.webhook.timeoutMs') ?? 5_000;
    // Without a timeout a hanging receiver would occupy the retry worker indefinitely.
    const abort = AbortSignal.timeout(timeoutMs);

    const secret = this.config.get<string>('notifications.webhook.secret');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Lets the receiver verify the POST came from this hub. A shared header is
        // weaker than an HMAC over the body, which is the natural upgrade.
        ...(secret ? { 'x-hub-secret': secret } : {}),
      },
      body: JSON.stringify({ event: 'alert', alert }),
      signal: abort,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // 4xx other than 429 will never succeed on retry, but distinguishing that from
      // a transient 5xx is the dispatcher's job via the attempt cap.
      throw new Error(`webhook ${url} returned ${response.status}: ${body.slice(0, 200)}`);
    }

    this.logger.log(`Posted ${alert.type} (${alert.id}) to webhook`);
  }
}
