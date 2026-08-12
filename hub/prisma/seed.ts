import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Creates the singleton SystemState row so a fresh database starts `disarmed`.
 *
 * SystemService also upserts on read, so the app works even if this never runs —
 * the seed exists to make `prisma studio` show a sensible row immediately and to
 * document the intended initial state. No demo agents are seeded: agents create
 * themselves on register, and fake rows would show as offline within 30s and
 * raise misleading agent_offline alerts.
 */
async function main(): Promise<void> {
  const state = await prisma.systemState.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, mode: 'disarmed' },
  });
  console.log(`SystemState ready — mode=${state.mode}`);
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
