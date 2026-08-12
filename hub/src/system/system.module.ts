import { Module } from '@nestjs/common';

import { RealtimeModule } from '../realtime/realtime.module';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';

@Module({
  imports: [RealtimeModule],
  controllers: [SystemController],
  providers: [SystemService],
  exports: [SystemService],
})
export class SystemModule {}
