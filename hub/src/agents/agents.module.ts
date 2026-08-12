import { Module } from '@nestjs/common';

import { AlertsModule } from '../alerts/alerts.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { AgentLivenessService } from './agent-liveness.service';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [RealtimeModule, AlertsModule],
  controllers: [AgentsController],
  providers: [AgentsService, AgentLivenessService],
  exports: [AgentsService],
})
export class AgentsModule {}
