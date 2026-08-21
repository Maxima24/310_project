import {
  AuditAction,
  AuditOutcome,
  type AgentAckResponse,
  type AgentView,
} from '@cpe310/contracts';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import type { AuthenticatedRequest } from '../common/guards/auth.guard';
import {
  CanEnrollAgents,
  CanHeartbeat,
  CanReadAgents,
} from '../common/guards/permissions.decorator';
import { AgentsService } from './agents.service';
import { RegisterAgentDto } from './dto/register-agent.dto';

@Controller('agents')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Enrollment. The bootstrap key gets an agent exactly one thing — a token of its
   * own — and cannot be used for anything else.
   *
   * A re-enrollment is audited as a ROTATION rather than an enrollment, because that
   * is the security-relevant event: it silently invalidates the token the previous
   * holder had. Legitimate when an agent loses its token file, and also exactly what
   * someone who stole the bootstrap key would do — which is why it needs to be
   * queryable rather than buried in a log.
   */
  @Post('register')
  @CanEnrollAgents()
  @HttpCode(HttpStatus.OK)
  async register(
    @Body() dto: RegisterAgentDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<AgentAckResponse> {
    const result = await this.agents.register(dto);
    const rotated = result.enrollment?.rotated ?? false;

    await this.audit.record({
      ...this.audit.actorFromRequest(request),
      action: rotated ? AuditAction.AgentTokenRotated : AuditAction.AgentEnrolled,
      outcome: AuditOutcome.Allowed,
      targetType: 'agent',
      targetId: dto.id,
      detail: { type: dto.type, location: dto.location, version: dto.version ?? null },
    });

    return result;
  }

  /** The guard additionally enforces that `:id` matches the calling token's agent. */
  @Post(':id/heartbeat')
  @CanHeartbeat()
  @HttpCode(HttpStatus.OK)
  heartbeat(@Param('id') id: string): Promise<AgentAckResponse> {
    return this.agents.heartbeat(id);
  }

  /**
   * Fleet status. Sensors cannot enumerate their peers, and a zone-restricted viewer
   * sees only the agents in its own zones.
   */
  @Get()
  @CanReadAgents()
  findAll(@Req() request: AuthenticatedRequest): Promise<AgentView[]> {
    return this.agents.findAll(request.identity);
  }
}
