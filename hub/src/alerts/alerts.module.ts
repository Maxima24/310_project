import { Module } from '@nestjs/common';

import { RealtimeModule } from '../realtime/realtime.module';
import { SystemModule } from '../system/system.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';

@Module({
  imports: [RealtimeModule, SystemModule],
  controllers: [AlertsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
