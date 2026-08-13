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
  // Exported for MqttModule: MQTT ingestion routes through the same service so alert
  // rules, dedup, and liveness cannot drift between the two transports.
  exports: [EventsService],
})
export class EventsModule {}
