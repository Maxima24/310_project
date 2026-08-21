import { Module } from '@nestjs/common';

import { AgentsModule } from '../agents/agents.module';
import { PrismaModule } from '../common/prisma/prisma.module';
import { BrowserCameraService } from './browser-camera.service';
import { BrowserCamerasController } from './browser-cameras.controller';
import { CamerasController } from './cameras.controller';
import { FrameStoreService } from './frame-store.service';

/**
 * Live camera view. Holds only the newest frame per camera, in memory — see
 * FrameStoreService for why nothing here is persisted.
 */
@Module({
  imports: [AgentsModule, PrismaModule],
  controllers: [CamerasController, BrowserCamerasController],
  providers: [FrameStoreService, BrowserCameraService],
  // Exported for the retention sweep, which reaps ended browser sessions.
  exports: [BrowserCameraService],
})
export class CamerasModule {}
