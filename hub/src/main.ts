import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Events carry a free-form `metadata` object, so cap the body explicitly rather
    // than relying on the framework default. 64kB is generous for sensor readings
    // and keeps a misbehaving (or hostile) agent from writing multi-megabyte rows
    // into Postgres on every poll. Video evidence is a URL reference by design
    // (roadmap item 5), not an inline payload, so this ceiling stays valid.
    bodyParser: true,
    rawBody: false,
  });
  app.useBodyParser('json', { limit: '64kb' });

  // Camera frames are JPEG, not JSON, and a 64kB cap would reject every one of them.
  // Scoped by content type so this larger ceiling applies ONLY to image bodies —
  // an oversized JSON payload is still refused above.
  app.useBodyParser('raw', { type: 'image/jpeg', limit: '2mb' });

  const config = app.get(ConfigService);
  const port = config.get<number>('port') ?? 3000;

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown keys instead of trusting them into Prisma.
      whitelist: true,
      forbidNonWhitelisted: false,
      // Needed for @Type(() => Number) on query DTOs, since query strings arrive as text.
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Lets Nest run onModuleDestroy, which closes the Prisma pool on SIGTERM —
  // without it `docker compose down` leaks connections until the container is killed.
  app.enableShutdownHooks();

  await app.listen(port, '0.0.0.0');
  logger.log(`Hub listening on http://0.0.0.0:${port} (WebSocket on the same port)`);
}

void bootstrap().catch((error: unknown) => {
  // Config validation failures land here. Print the reason plainly — a stack
  // trace for "AGENT_API_KEY is required" only obscures the fix.
  console.error(`Hub failed to start: ${(error as Error).message}`);
  process.exit(1);
});
