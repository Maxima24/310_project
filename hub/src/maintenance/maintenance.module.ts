import { Module } from '@nestjs/common';

import { CamerasModule } from '../cameras/cameras.module';
import { PrismaModule } from '../common/prisma/prisma.module';
import { RetentionService } from './retention.service';

/**
 * Scheduled housekeeping. Separate from the feature modules because retention is not
 * a property of events or alerts individually — it is a policy applied across all of
 * them, and burying it inside EventsModule would hide the fact that it deletes rows
 * three other modules own.
 */
@Module({
  // CamerasModule for the browser-session reaper: an ended session is housekeeping, and
  // housekeeping runs on one schedule rather than each module inventing its own timer.
  imports: [PrismaModule, CamerasModule],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class MaintenanceModule {}
