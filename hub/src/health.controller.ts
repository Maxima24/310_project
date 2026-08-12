import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { PrismaService } from './common/prisma/prisma.service';
import { Public } from './common/guards/public.decorator';

interface HealthReport {
  status: 'ok';
  database: 'up';
  uptimeSeconds: number;
}

/**
 * The one unauthenticated route: Docker's healthcheck and any load balancer need
 * to reach it without holding the agent key.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async check(): Promise<HealthReport> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      // Must be a non-2xx: a hub that cannot reach Postgres can neither ingest
      // events nor raise alerts. Reporting 200 here would let compose start the
      // agents against a hub that 500s on every report.
      throw new ServiceUnavailableException({
        status: 'degraded',
        database: 'down',
        reason: (error as Error).message,
      });
    }

    return { status: 'ok', database: 'up', uptimeSeconds: Math.round(process.uptime()) };
  }
}
