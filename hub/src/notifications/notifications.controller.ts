import type { NotificationView } from '@cpe310/contracts';
import { Controller, Get, Param, Query } from '@nestjs/common';

import { CanReadNotifications } from '../common/guards/permissions.decorator';
import { NotificationsService } from './notifications.service';

/**
 * Delivery audit. Admin-only: it answers "was anyone actually told, and did it work?",
 * and it exposes recipient addresses and webhook errors — more than a day-to-day
 * operator needs, and certainly more than a sensor.
 */
@Controller('notifications')
@CanReadNotifications()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  findMany(@Query('limit') limit?: string): Promise<NotificationView[]> {
    const parsed = Number(limit);
    return this.notifications.findMany(
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50,
    );
  }

  @Get('alert/:alertId')
  findForAlert(@Param('alertId') alertId: string): Promise<NotificationView[]> {
    return this.notifications.findForAlert(alertId);
  }
}
