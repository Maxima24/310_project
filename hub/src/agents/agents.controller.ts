import type { AgentAckResponse, AgentView } from '@cpe310/contracts';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';

import { AgentsService } from './agents.service';
import { RegisterAgentDto } from './dto/register-agent.dto';

@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post('register')
  @HttpCode(HttpStatus.OK)
  register(@Body() dto: RegisterAgentDto): Promise<AgentAckResponse> {
    return this.agents.register(dto);
  }

  @Post(':id/heartbeat')
  @HttpCode(HttpStatus.OK)
  heartbeat(@Param('id') id: string): Promise<AgentAckResponse> {
    return this.agents.heartbeat(id);
  }

  @Get()
  findAll(): Promise<AgentView[]> {
    return this.agents.findAll();
  }
}
