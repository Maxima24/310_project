import type { AlertView } from '@cpe310/contracts';
import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';

import type { AuthenticatedRequest } from '../common/guards/auth.guard';
import { CanAcknowledge, CanReadAlerts } from '../common/guards/permissions.decorator';
import { PolicyService } from '../common/security/policy.service';
import { AlertsService } from './alerts.service';
import { QueryAlertsDto } from './dto/query-alerts.dto';

@Controller('alerts')
export class AlertsController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly policy: PolicyService,
  ) {}

  /** Viewers and above; zone-restricted callers see only their own zones. */
  @Get()
  @CanReadAlerts()
  findMany(
    @Query() query: QueryAlertsDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<AlertView[]> {
    return this.alerts.findMany(query, request.identity);
  }

  /**
   * Acknowledgement is deliberately not reachable by a sensor token: an intruder who
   * compromised one sensor could otherwise silence the very alert its tampering raised.
   *
   * The permission check is the guard's job; the attribute check here is zone scoping,
   * so an operator responsible for one wing cannot clear the whole building.
   */
  @Post(':id/ack')
  @CanAcknowledge()
  @HttpCode(HttpStatus.OK)
  async acknowledge(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<AlertView> {
    const decision = await this.policy.canAcknowledgeAlert(request.identity!, id);
    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason);
    }
    return this.alerts.acknowledge(id);
  }
}
