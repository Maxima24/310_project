import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to Postgres');
  }

  /**
   * Nest calls this on shutdown, which closes the pool cleanly. Without it,
   * `nest start --watch` leaks a connection per reload until Postgres refuses
   * new ones.
   */
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
