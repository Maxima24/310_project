import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { AgentsModule } from './agents/agents.module';
import { AlertsModule } from './alerts/alerts.module';
import { ApiKeyGuard } from './common/guards/api-key.guard';
import { PrismaModule } from './common/prisma/prisma.module';
import { loadConfiguration } from './config/configuration';
import { EventsModule } from './events/events.module';
import { HealthController } from './health.controller';
import { RealtimeModule } from './realtime/realtime.module';
import { SystemModule } from './system/system.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Validation happens inside loadConfiguration, which throws on a bad env —
      // the process must die at boot rather than 401 mysteriously later.
      load: [loadConfiguration],
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    RealtimeModule,
    SystemModule,
    AlertsModule,
    AgentsModule,
    EventsModule,
  ],
  controllers: [HealthController],
  providers: [
    // Global so every new controller is authenticated by default; opting out
    // requires an explicit @Public().
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
})
export class AppModule {}
