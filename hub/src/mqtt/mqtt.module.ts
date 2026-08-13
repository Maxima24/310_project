import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { EventsModule } from '../events/events.module';
import { MqttIngestService } from './mqtt-ingest.service';

/**
 * Optional second ingestion transport (roadmap item 4). Inert unless MQTT_URL is set,
 * so the verified HTTP path stays the default.
 */
@Module({
  imports: [AgentsModule, EventsModule],
  providers: [MqttIngestService],
})
export class MqttModule {}
