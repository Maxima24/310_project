import { AuditAction, AuditOutcome, type AlertView } from '@cpe310/contracts';
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

import { AuditService } from '../audit/audit.service';
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
    private readonly audit: AuditService,
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
    const actor = this.audit.actorFromRequest(request);
    const decision = await this.policy.canAcknowledgeAlert(request.identity!, id);

    if (!decision.allowed) {
      await this.audit.record({
        ...actor,
        action: AuditAction.AlertAcknowledged,
        outcome: AuditOutcome.Denied,
        reason: decision.reason,
        targetType: 'alert',
        targetId: id,
      });
      throw new ForbiddenException(decision.reason);
    }

    const alert = await this.alerts.acknowledge(id);

    // Acknowledging is the act of taking responsibility for an incident, so the record
    // of who did it carries the same weight as the alert itself.
    await this.audit.record({
      ...actor,
      action: AuditAction.AlertAcknowledged,
      outcome: AuditOutcome.Allowed,
      targetType: 'alert',
      targetId: id,
      detail: { type: alert.type, severity: alert.severity, agentId: alert.agentId },
    });

    return alert;
  }
}
