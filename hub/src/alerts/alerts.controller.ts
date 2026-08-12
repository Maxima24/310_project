import type { AlertView } from '@cpe310/contracts';
import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';

import { AlertsService } from './alerts.service';
import { QueryAlertsDto } from './dto/query-alerts.dto';

@Controller('alerts')
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
