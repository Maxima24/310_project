import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { AgentsModule } from './agents/agents.module';
import { AlertsModule } from './alerts/alerts.module';
import { AuthModule } from './auth/auth.module';
import { CamerasModule } from './cameras/cameras.module';
import { AuthGuard } from './common/guards/auth.guard';
import { PrismaModule } from './common/prisma/prisma.module';
import { SecurityModule } from './common/security/security.module';
import { loadConfiguration } from './config/configuration';
import { EventsModule } from './events/events.module';
import { HealthController } from './health.controller';
import { MqttModule } from './mqtt/mqtt.module';
import { NotificationsModule } from './notifications/notifications.module';
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
    SecurityModule,
    AuthModule,
    RealtimeModule,
    SystemModule,
    NotificationsModule,
    AlertsModule,
    AgentsModule,
    EventsModule,
    CamerasModule,
    MqttModule,
  ],
  controllers: [HealthController],
  providers: [
    // Global so every new controller is authenticated by default. With no @Roles
    // decorator the guard demands the operator credential, so a route added later
    // is locked down rather than accidentally reachable by a sensor token.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
