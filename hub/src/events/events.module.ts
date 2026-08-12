import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { AlertsModule } from '../alerts/alerts.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [AgentsModule, AlertsModule, RealtimeModule],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
