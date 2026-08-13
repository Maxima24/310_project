import type { AlertView } from '@cpe310/contracts';
import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';

import { OperatorOnly } from '../common/guards/roles.decorator';
import { AlertsService } from './alerts.service';
import { QueryAlertsDto } from './dto/query-alerts.dto';

/**
 * Operator-only throughout. Acknowledgement in particular must never be reachable
 * by a sensor token: an intruder who compromised one sensor could otherwise silence
 * the very alert its tampering raised.
 */
@Controller('alerts')
@OperatorOnly()
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  findMany(@Query() query: QueryAlertsDto): Promise<AlertView[]> {
    return this.alerts.findMany(query);
  }

  @Post(':id/ack')
  @HttpCode(HttpStatus.OK)
  acknowledge(@Param('id') id: string): Promise<AlertView> {
    return this.alerts.acknowledge(id);
  }
}
