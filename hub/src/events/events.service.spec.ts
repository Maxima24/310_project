import { AgentStatus, EventType } from '@cpe310/contracts';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Agent } from '@prisma/client';

import { AgentsService } from '../agents/agents.service';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { EventsService } from './events.service';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const agentRow = {
  id: 'motion-hallway',
  type: 'motion',
  location: 'Hallway',
  status: AgentStatus.Online,
} as Agent;

function isoNow(): string {
  return new Date().toISOString();
}

async function buildService(agent: Agent | null = agentRow) {
  const prisma = {
    event: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'event-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          metadata: {},
          ...data,
        }),
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const agents = {
    findOne: jest.fn().mockResolvedValue(agent),
    recordActivity: jest.fn().mockResolvedValue(agent),
  };
  const alerts = { evaluateEvent: jest.fn().mockResolvedValue(null) };
  const realtime = { emitEvent: jest.fn() };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'pagination.defaultLimit') return DEFAULT_LIMIT;
      if (key === 'pagination.maxLimit') return MAX_LIMIT;
      return undefined;
    }),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      EventsService,
      { provide: PrismaService, useValue: prisma },
      { provide: AgentsService, useValue: agents },
      { provide: AlertsService, useValue: alerts },
      { provide: RealtimeGateway, useValue: realtime },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();

  return { service: moduleRef.get(EventsService), prisma, agents, alerts, realtime };
}

describe('EventsService.ingest', () => {
  it('rejects an event from an unregistered agent', async () => {
    // Auto-creating would turn a typo'd --id into a phantom sensor nobody monitors,
    // and there would be no type/location to evaluate rules against.
    const { service, prisma } = await buildService(null);

    await expect(
      service.ingest({ agentId: 'ghost', type: EventType.MotionDetected, occurredAt: isoNow() }),
    ).rejects.toThrow(/not registered/i);
    expect(prisma.event.create).not.toHaveBeenCalled();
  });

  it('treats an event as proof of life via the shared recovery path', async () => {
    // recordActivity (not a bare status write) is what clears an open agent_offline
    // alert when an agent's activity arrives as an event rather than a heartbeat.
    const { service, agents } = await buildService();

    await service.ingest({
      agentId: 'motion-hallway',
      type: EventType.MotionDetected,
      occurredAt: isoNow(),
    });

    expect(agents.recordActivity).toHaveBeenCalledWith(agentRow);
  });

  it('persists before broadcasting so a client cannot see an event GET does not return', async () => {
    const order: string[] = [];
    const { service, prisma, realtime } = await buildService();
    prisma.event.create.mockImplementation(() => {
      order.push('persist');
      return Promise.resolve({
        id: 'event-1',
        agentId: 'motion-hallway',
        type: EventType.MotionDetected,
        metadata: {},
        occurredAt: new Date(),
        createdAt: new Date(),
      });
    });
    realtime.emitEvent.mockImplementation(() => void order.push('broadcast'));

    await service.ingest({
      agentId: 'motion-hallway',
      type: EventType.MotionDetected,
      occurredAt: isoNow(),
    });

    expect(order).toEqual(['persist', 'broadcast']);
  });

  it('defaults missing metadata to an empty object rather than null', async () => {
    const { service, prisma } = await buildService();

    await service.ingest({
      agentId: 'motion-hallway',
      type: EventType.MotionDetected,
      occurredAt: isoNow(),
    });

    expect(prisma.event.create.mock.calls[0][0].data.metadata).toEqual({});
  });

  it('returns the alert alongside the event so an agent can log what it tripped', async () => {
    const { service, alerts } = await buildService();
    alerts.evaluateEvent.mockResolvedValue({ id: 'alert-1', type: 'intrusion_motion' });

    const result = await service.ingest({
      agentId: 'motion-hallway',
      type: EventType.MotionDetected,
      occurredAt: isoNow(),
    });

    expect(result.alert).toEqual({ id: 'alert-1', type: 'intrusion_motion' });
  });

  it('stores an event whose clock is badly skewed instead of rejecting it', async () => {
    // Refusing would discard a real intrusion report because of a bad NTP setup.
    // Ordering uses the hub's own createdAt, so skew is a warning, never a drop.
    const { service, prisma } = await buildService();
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    await service.ingest({
      agentId: 'motion-hallway',
      type: EventType.MotionDetected,
      occurredAt: '2016-01-01T00:00:00.000Z',
    });

    expect(prisma.event.create).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('clock is'));
  });

  it('does not warn about a normal, near-current timestamp', async () => {
    const { service } = await buildService();
    const warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);

    await service.ingest({
      agentId: 'motion-hallway',
      type: EventType.MotionDetected,
      occurredAt: isoNow(),
    });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('EventsService.findMany', () => {
  it('applies the configured default when no limit is given', async () => {
    const { service, prisma } = await buildService();

    await service.findMany({});

    expect(prisma.event.findMany.mock.calls[0][0].take).toBe(DEFAULT_LIMIT);
  });

  it('clamps an absurd limit to the configured maximum', async () => {
    // Without the clamp one request could try to serialise the whole table.
    const { service, prisma } = await buildService();

    await service.findMany({ limit: 99_999 });

    expect(prisma.event.findMany.mock.calls[0][0].take).toBe(MAX_LIMIT);
  });

  it('orders by hub receive time descending, not agent-reported time', async () => {
    const { service, prisma } = await buildService();

    await service.findMany({});

    expect(prisma.event.findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
  });

  it('filters by agent, type, and since when supplied', async () => {
    const { service, prisma } = await buildService();

    await service.findMany({
      agentId: 'door-front',
      type: EventType.DoorOpened,
      since: '2026-01-01T00:00:00.000Z',
    });

    const where = prisma.event.findMany.mock.calls[0][0].where;
    expect(where.agentId).toBe('door-front');
    expect(where.type).toBe(EventType.DoorOpened);
    expect(where.createdAt.gt).toBeInstanceOf(Date);
  });
});
