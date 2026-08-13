import type { AgentAckResponse, AgentView } from '@cpe310/contracts';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';

import { AgentOnly, BootstrapOnly, OperatorOnly } from '../common/guards/roles.decorator';
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
  @BootstrapOnly()
  @HttpCode(HttpStatus.OK)
  register(@Body() dto: RegisterAgentDto): Promise<AgentAckResponse> {
    return this.agents.register(dto);
  }

  /** The guard additionally enforces that `:id` matches the calling token's agent. */
  @Post(':id/heartbeat')
  @AgentOnly()
  @HttpCode(HttpStatus.OK)
  heartbeat(@Param('id') id: string): Promise<AgentAckResponse> {
    return this.agents.heartbeat(id);
  }

  /** Fleet status is operator information — a sensor has no business enumerating its peers. */
  @Get()
  @OperatorOnly()
  findAll(): Promise<AgentView[]> {
    return this.agents.findAll();
  }
}
