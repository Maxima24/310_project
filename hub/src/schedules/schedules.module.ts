import { Module } from '@nestjs/common';

import { PrismaModule } from '../common/prisma/prisma.module';
import { SecurityModule } from '../common/security/security.module';
import { SystemModule } from '../system/system.module';
import { ScheduleRunnerService } from './schedule-runner.service';
import { SchedulesController } from './schedules.controller';
import { SchedulesService } from './schedules.service';

@Module({
  // SystemModule rather than a private copy of the mode logic: a scheduled change must
  // broadcast and short-circuit exactly like a manual one.
  imports: [PrismaModule, SecurityModule, SystemModule],
  controllers: [SchedulesController],
  providers: [SchedulesService, ScheduleRunnerService],
  exports: [SchedulesService],
})
export class SchedulesModule {}
