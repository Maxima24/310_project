import type { NotificationView } from '@cpe310/contracts';
import { Controller, Get, Param, Query } from '@nestjs/common';

import { OperatorOnly } from '../common/guards/roles.decorator';
import { NotificationsService } from './notifications.service';

/**
 * Delivery audit. Operator-only: it answers "was anyone actually told, and did it
 * work?", which is exactly the question after an incident — and not something a
 * sensor has any business asking.
 */
@Controller('notifications')
@OperatorOnly()
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
