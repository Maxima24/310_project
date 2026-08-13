import { Module } from '@nestjs/common';

import { EmailChannel } from './channels/email.channel';
import { LogChannel } from './channels/log.channel';
import { WebhookChannel } from './channels/webhook.channel';
import { ALERT_CHANNELS } from './channels/channels.token';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    LogChannel,
    EmailChannel,
    WebhookChannel,
    {
      provide: ALERT_CHANNELS,
      // Order matters only for log readability; delivery is independent per channel.
      // Adding Twilio or FCM (roadmap item 3's remaining channels) means adding the
      // class here and nothing else.
      inject: [LogChannel, EmailChannel, WebhookChannel],
      useFactory: (log: LogChannel, email: EmailChannel, webhook: WebhookChannel) => [
        log,
        email,
        webhook,
      ],
    },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
