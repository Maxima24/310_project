import { AlertSeverity, AlertType, EventType, SystemMode } from '@cpe310/contracts';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SystemService } from '../system/system.service';
import { AlertsService } from './alerts.service';
import type { RuleAgent } from './alert-rules';

const COOLDOWN_MS = 60_000;

const agent: RuleAgent = { id: 'motion-hallway', type: 'motion', location: 'Hallway' };

/**
 * Prisma is mocked rather than backed by a test database: the behaviour under test
 * is the dedup decision, which is ours, not Postgres's. Keeps the suite fast and
 * runnable with no containers.
 */
function makePrismaMock() {
  return {
    alert: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'alert-1',
          acknowledged: false,
          acknowledgedAt: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          agentId: null,
          eventId: null,
          ...data,
        }),
      ),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

async function buildService(mode: SystemMode = SystemMode.Away) {
  const prisma = makePrismaMock();
  const realtime = { emitAlert: jest.fn(), emitEvent: jest.fn(), emitMode: jest.fn(), emitAgent: jest.fn() };
  const system = { getMode: jest.fn().mockResolvedValue({ mode, updatedAt: '' }) };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'alerts.cooldownMs') return COOLDOWN_MS;
      if (key === 'pagination.defaultLimit') return 50;
      if (key === 'pagination.maxLimit') return 200;
      return undefined;
    }),
  };

  const notifications = { dispatch: jest.fn().mockResolvedValue(undefined) };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AlertsService,
      { provide: PrismaService, useValue: prisma },
      { provide: RealtimeGateway, useValue: realtime },
      { provide: SystemService, useValue: system },
      { provide: ConfigService, useValue: config },
      { provide: NotificationsService, useValue: notifications },
    ],
  }).compile();

  return { service: moduleRef.get(AlertsService), prisma, realtime, system, notifications };
}

describe('AlertsService.evaluateEvent', () => {
  it('persists then broadcasts when the rules fire', async () => {
    const { service, prisma, realtime } = await buildService(SystemMode.Away);

    const alert = await service.evaluateEvent(agent, EventType.MotionDetected, 'event-1');

    expect(alert).not.toBeNull();
    expect(alert?.type).toBe(AlertType.IntrusionMotion);
    expect(alert?.severity).toBe(AlertSeverity.Critical);
    expect(prisma.alert.create).toHaveBeenCalledTimes(1);
    expect(realtime.emitAlert).toHaveBeenCalledTimes(1);

    // The arm mode that produced the alert is recorded on the row.
    expect(prisma.alert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ modeAtTrigger: SystemMode.Away, eventId: 'event-1' }),
      }),
    );
  });

  it('writes nothing when the rules stay silent', async () => {
    const { service, prisma, realtime } = await buildService(SystemMode.Home);

    const alert = await service.evaluateEvent(agent, EventType.MotionDetected, 'event-1');

    expect(alert).toBeNull();
    expect(prisma.alert.create).not.toHaveBeenCalled();
    expect(realtime.emitAlert).not.toHaveBeenCalled();
  });

  it('hands the alert to the notification fan-out', async () => {
    const { service, notifications } = await buildService(SystemMode.Away);

    const alert = await service.evaluateEvent(agent, EventType.MotionDetected, 'event-1');

    expect(notifications.dispatch).toHaveBeenCalledWith(alert);
  });

  it('does not notify when no alert was raised', async () => {
    const { service, notifications } = await buildService(SystemMode.Home);

    await service.evaluateEvent(agent, EventType.MotionDetected, 'event-1');

    expect(notifications.dispatch).not.toHaveBeenCalled();
  });

  it('still returns the alert when notification dispatch rejects', async () => {
    // Fan-out is fire-and-forget: the alert is already persisted and broadcast, so a
    // failing SMTP server must not turn a successful ingestion into an error.
    const { service, notifications } = await buildService(SystemMode.Away);
    notifications.dispatch.mockRejectedValue(new Error('smtp down'));

    const alert = await service.evaluateEvent(agent, EventType.MotionDetected, 'event-1');

    expect(alert).not.toBeNull();
  });
});

describe('AlertsService cooldown', () => {
  it('suppresses a repeat of the same (type, agent) inside the window', async () => {
    const { service, prisma, realtime } = await buildService(SystemMode.Away);
    // An unacknowledged alert already exists within the cooldown.
    prisma.alert.findFirst.mockResolvedValue({ id: 'existing' });

    const alert = await service.evaluateEvent(agent, EventType.MotionDetected, 'event-2');

    expect(alert).toBeNull();
    expect(prisma.alert.create).not.toHaveBeenCalled();
    expect(realtime.emitAlert).not.toHaveBeenCalled();
  });

  it('scopes the dedup query to type, agent, unacknowledged, and the window', async () => {
    const { service, prisma } = await buildService(SystemMode.Away);

    await service.evaluateEvent(agent, EventType.MotionDetected, 'event-3');

    const where = prisma.alert.findFirst.mock.calls[0][0].where;
    expect(where.type).toBe(AlertType.IntrusionMotion);
    expect(where.agentId).toBe(agent.id);
    expect(where.acknowledged).toBe(false);
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });

  it('does not let an acknowledged alert suppress a new one', async () => {
    // findFirst filters on acknowledged: false, so an acked row simply is not
    // found — once a human has cleared an alert, the next trip is real news.
    const { service, prisma } = await buildService(SystemMode.Away);
    prisma.alert.findFirst.mockResolvedValue(null);

    const alert = await service.evaluateEvent(agent, EventType.MotionDetected, 'event-4');

    expect(alert).not.toBeNull();
    expect(prisma.alert.create).toHaveBeenCalledTimes(1);
  });

  it('skips the cooldown entirely for recovery notices', async () => {
    const { service, prisma } = await buildService(SystemMode.Away);
    prisma.alert.findFirst.mockResolvedValue({ id: 'existing' });

    const alert = await service.raiseAgentRecovered(agent);

    // A recovery is the counterpart to a specific offline alert; suppressing it
    // would leave a dashboard stuck showing the agent as offline.
    expect(alert).not.toBeNull();
    expect(alert?.type).toBe(AlertType.AgentRecovered);
    expect(prisma.alert.findFirst).not.toHaveBeenCalled();
    expect(prisma.alert.create).toHaveBeenCalledTimes(1);
  });
});

describe('AlertsService.raiseAgentOffline', () => {
  it('records no eventId, since the sweep has no event to point at', async () => {
    const { service, prisma } = await buildService(SystemMode.Away);

    await service.raiseAgentOffline(agent, 32_000);

    expect(prisma.alert.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: AlertType.AgentOffline, eventId: null }),
      }),
    );
  });
});

describe('AlertsService.acknowledge', () => {
  it('is idempotent and leaves the original timestamp alone', async () => {
    const { service, prisma } = await buildService();
    const already = {
      id: 'alert-9',
      type: AlertType.IntrusionDoor,
      severity: AlertSeverity.Critical,
      message: 'x',
      agentId: 'door-front',
      eventId: null,
      modeAtTrigger: SystemMode.Away,
      acknowledged: true,
      acknowledgedAt: new Date('2026-01-01T00:00:00.000Z'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    prisma.alert.findUnique.mockResolvedValue(already);

    const view = await service.acknowledge('alert-9');

    expect(view.acknowledged).toBe(true);
    expect(prisma.alert.update).not.toHaveBeenCalled();
  });

  it('404s on an unknown id', async () => {
    const { service, prisma } = await buildService();
    prisma.alert.findUnique.mockResolvedValue(null);

    await expect(service.acknowledge('nope')).rejects.toThrow(/not found/i);
  });
});

describe('AlertsService.acknowledgeOpenOfflineAlerts', () => {
  it('clears only unacknowledged agent_offline alerts for that agent', async () => {
    const { service, prisma } = await buildService();
    prisma.alert.updateMany.mockResolvedValue({ count: 2 });

    const count = await service.acknowledgeOpenOfflineAlerts('door-front');

    expect(count).toBe(2);
    expect(prisma.alert.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId: 'door-front', type: AlertType.AgentOffline, acknowledged: false },
      }),
    );
  });
});
