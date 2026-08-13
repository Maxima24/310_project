import type { AgentAckResponse, AgentView } from '@cpe310/contracts';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';

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
  constructor(private readonly agents: AgentsService) {}

  /**
   * Enrollment. The bootstrap key gets an agent exactly one thing — a token of its
   * own — and cannot be used for anything else.
   */
  @Post('register')
  @CanEnrollAgents()
  @HttpCode(HttpStatus.OK)
  register(@Body() dto: RegisterAgentDto): Promise<AgentAckResponse> {
    return this.agents.register(dto);
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
