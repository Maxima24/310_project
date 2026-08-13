import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { CamerasController } from './cameras.controller';
import { FrameStoreService } from './frame-store.service';

/**
 * Live camera view. Holds only the newest frame per camera, in memory — see
 * FrameStoreService for why nothing here is persisted.
 */
@Module({
  imports: [AgentsModule],
  controllers: [CamerasController],
  providers: [FrameStoreService],
})
export class CamerasModule {}
