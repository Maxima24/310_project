import { AuthRole, Permission, ROLE_PERMISSIONS, SystemMode } from '@cpe310/contracts';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../common/prisma/prisma.service';
import { PolicyService } from '../common/security/policy.service';
import { SchedulesService } from './schedules.service';

const VALID = {
  name: 'Nightly arm',
  mode: SystemMode.Away,
  startMinute: 22 * 60,
  timezone: 'America/New_York',
};

async function buildService() {
  const prisma = {
    armSchedule: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve(row(data))),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve(row(data))),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };

  const moduleRef = await Test.createTestingModule({
    providers: [SchedulesService, { provide: PrismaService, useValue: prisma }],
  }).compile();

  return { service: moduleRef.get(SchedulesService), prisma };
}

function row(data: Record<string, unknown>) {
  return {
    id: 'sched-1',
    enabled: true,
    daysOfWeek: [],
    lastFiredAt: null,
    lastFiredFor: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  };
}

describe('SchedulesService validation', () => {
  it('rejects a time zone this platform cannot resolve', async () => {
    // Caught here rather than inside a cron job at 03:00, which is the worst possible
    // place to discover it.
    const { service } = await buildService();

    await expect(service.create({ ...VALID, timezone: 'America/Metropolis' })).rejects.toThrow(
      /not a time zone/i,
    );
  });

  it('rejects a start minute outside the day', async () => {
    const { service } = await buildService();

    await expect(service.create({ ...VALID, startMinute: 1440 })).rejects.toThrow(/startMinute/);
    await expect(service.create({ ...VALID, startMinute: -1 })).rejects.toThrow(/startMinute/);
  });

  it('rejects a blank name', async () => {
    const { service } = await buildService();

    await expect(service.create({ ...VALID, name: '   ' })).rejects.toThrow(/name/i);
  });

  it('rejects a day outside 0-6', async () => {
    const { service } = await buildService();

    await expect(service.create({ ...VALID, daysOfWeek: [7] })).rejects.toThrow(/daysOfWeek/);
  });

  it('deduplicates and sorts the day list', async () => {
    const { service, prisma } = await buildService();

    await service.create({ ...VALID, daysOfWeek: [5, 1, 5, 3] });

    expect(prisma.armSchedule.create.mock.calls[0][0].data.daysOfWeek).toEqual([1, 3, 5]);
  });
});

describe('SchedulesService creation seeding', () => {
  it('does not report a miss for a window it did not exist for', async () => {
    // Created at 23:00 local saying "arm at 22:00": it did not exist at 22:00, so
    // stamping today makes tomorrow the first boundary it can act on.
    const { service, prisma } = await buildService();

    await service.create(VALID, new Date('2026-08-15T03:00:00Z')); // 23:00 in New York

    expect(prisma.armSchedule.create.mock.calls[0][0].data.lastFiredFor).toBe('2026-08-14');
  });

  it('leaves today available when the boundary is still ahead', async () => {
    const { service, prisma } = await buildService();

    await service.create(VALID, new Date('2026-08-14T18:00:00Z')); // 14:00 in New York

    expect(prisma.armSchedule.create.mock.calls[0][0].data.lastFiredFor).toBeNull();
  });

  it('re-seeds when an edit moves the boundary', async () => {
    const { service, prisma } = await buildService();
    prisma.armSchedule.findUnique.mockResolvedValue(
      row({ ...VALID, startMinute: 8 * 60, timezone: 'America/New_York' }),
    );

    await service.update('sched-1', VALID, new Date('2026-08-15T03:00:00Z'));

    expect(prisma.armSchedule.update.mock.calls[0][0].data.lastFiredFor).toBe('2026-08-14');
  });

  it('leaves the fire history alone when only the name changed', async () => {
    // Renaming a schedule must not make it eligible to fire a second time today.
    const { service, prisma } = await buildService();
    prisma.armSchedule.findUnique.mockResolvedValue(row(VALID));

    await service.update('sched-1', { ...VALID, name: 'Renamed' }, new Date());

    expect(prisma.armSchedule.update.mock.calls[0][0].data).not.toHaveProperty('lastFiredFor');
  });
});

describe('schedule authoring policy', () => {
  const policy = new PolicyService({} as never);

  function identity(role: AuthRole) {
    return { role, permissions: ROLE_PERMISSIONS[role], zones: [] };
  }

  it('lets an operator author an arming schedule', () => {
    expect(policy.canManageSchedule(identity(AuthRole.Operator), SystemMode.Away).allowed).toBe(
      true,
    );
  });

  it('lets an operator author a disarming schedule, because they may disarm', () => {
    expect(
      policy.canManageSchedule(identity(AuthRole.Operator), SystemMode.Disarmed).allowed,
    ).toBe(true);
  });

  it('refuses a viewer outright', () => {
    expect(policy.canManageSchedule(identity(AuthRole.Viewer), SystemMode.Away).allowed).toBe(
      false,
    );
  });

  it('refuses a schedule that exercises a permission its author lacks', () => {
    // The rule that stops schedules being a way to do indirectly what you may not do
    // directly, on a timer.
    const armOnly = {
      role: AuthRole.Operator,
      permissions: [Permission.SchedulesWrite, Permission.SystemArm],
      zones: [],
    };

    const decision = policy.canManageSchedule(armOnly, SystemMode.Disarmed);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/cannot grant a permission its author lacks/i);
  });
});

describe('schedule read permissions', () => {
  it('lets a viewer read schedules — knowing why the system will arm is part of reading it', () => {
    expect(ROLE_PERMISSIONS[AuthRole.Viewer]).toContain(Permission.SchedulesRead);
  });

  it('does not let a viewer write them', () => {
    expect(ROLE_PERMISSIONS[AuthRole.Viewer]).not.toContain(Permission.SchedulesWrite);
    expect(ROLE_PERMISSIONS[AuthRole.Operator]).toContain(Permission.SchedulesWrite);
  });

  it('keeps schedules out of an agent token entirely', () => {
    expect(ROLE_PERMISSIONS[AuthRole.Agent]).not.toContain(Permission.SchedulesRead);
    expect(ROLE_PERMISSIONS[AuthRole.Agent]).not.toContain(Permission.SchedulesWrite);
  });
});
