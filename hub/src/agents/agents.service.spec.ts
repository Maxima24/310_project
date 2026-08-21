import { AgentStatus } from '@cpe310/contracts';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Agent } from '@prisma/client';

import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AgentsService } from './agents.service';

function agentRow(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'door-front',
    type: 'door',
    location: 'Front door',
    status: AgentStatus.Online,
    version: '1.0.0',
    capabilities: ['door'],
    registeredAt: new Date('2026-01-01T00:00:00.000Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as Agent;
}

async function buildService(existing: Agent | null = null) {
  const prisma = {
    agent: {
      findUnique: jest.fn().mockResolvedValue(existing),
      upsert: jest.fn().mockImplementation(() => Promise.resolve(agentRow())),
      update: jest.fn().mockImplementation(({ data }: { data: Partial<Agent> }) =>
        Promise.resolve(agentRow({ ...data, status: AgentStatus.Online })),
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const realtime = { emitAgent: jest.fn() };
  const alerts = {
    acknowledgeOpenOfflineAlerts: jest.fn().mockResolvedValue(1),
    raiseAgentRecovered: jest.fn().mockResolvedValue(null),
  };
  const config = { get: jest.fn(() => 10_000) };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AgentsService,
      { provide: PrismaService, useValue: prisma },
      { provide: RealtimeGateway, useValue: realtime },
      { provide: AlertsService, useValue: alerts },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();

  return { service: moduleRef.get(AgentsService), prisma, realtime, alerts };
}

describe('AgentsService.register', () => {
  it('upserts so a restarting agent keeps its row and history', async () => {
    const { service, prisma } = await buildService(null);

    await service.register({ id: 'door-front', type: 'door', location: 'Front door' });

    expect(prisma.agent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'door-front' } }),
    );
  });

  it('does not wipe version or capabilities when a re-register omits them', async () => {
    // A minimal re-register (the transport's 404 recovery path, or a hand-rolled
    // client) should not silently erase what the agent reported earlier.
    const { service, prisma } = await buildService(agentRow());

    await service.register({ id: 'door-front', type: 'door', location: 'Front door' });

    const update = prisma.agent.upsert.mock.calls[0][0].update;
    expect(update).not.toHaveProperty('version');
    expect(update).not.toHaveProperty('capabilities');
  });

  it('still applies version and capabilities when they are supplied', async () => {
    const { service, prisma } = await buildService(agentRow());

    await service.register({
      id: 'door-front',
      type: 'door',
      location: 'Front door',
      version: '2.0.0',
      capabilities: ['door', 'tamper'],
    });

    const update = prisma.agent.upsert.mock.calls[0][0].update;
    expect(update.version).toBe('2.0.0');
    expect(update.capabilities).toEqual(['door', 'tamper']);
  });

  it('clears open offline alerts when a previously-offline agent re-registers', async () => {
    const { service, alerts } = await buildService(agentRow({ status: AgentStatus.Offline }));

    await service.register({ id: 'door-front', type: 'door', location: 'Front door' });

    expect(alerts.acknowledgeOpenOfflineAlerts).toHaveBeenCalledWith('door-front');
    expect(alerts.raiseAgentRecovered).toHaveBeenCalledTimes(1);
  });

  it('does not raise a recovery notice for an agent that was already online', async () => {
    const { service, alerts } = await buildService(agentRow({ status: AgentStatus.Online }));

    await service.register({ id: 'door-front', type: 'door', location: 'Front door' });

    expect(alerts.raiseAgentRecovered).not.toHaveBeenCalled();
  });
});

describe('AgentsService.heartbeat', () => {
  it('404s on an unknown agent so the transport re-registers instead of looping', async () => {
    const { service } = await buildService(null);

    await expect(service.heartbeat('ghost')).rejects.toThrow(/not registered/i);
  });

  it('stays quiet on the WebSocket for a routine beat from a healthy agent', async () => {
    const { service, realtime } = await buildService(agentRow({ status: AgentStatus.Online }));

    await service.heartbeat('door-front');

    // Otherwise a healthy fleet pushes a frame per second per agent for no news.
    expect(realtime.emitAgent).not.toHaveBeenCalled();
  });

  it('broadcasts and recovers when the beat comes from an offline agent', async () => {
    const { service, realtime, alerts } = await buildService(
      agentRow({ status: AgentStatus.Offline }),
    );

    await service.heartbeat('door-front');

    expect(alerts.acknowledgeOpenOfflineAlerts).toHaveBeenCalledWith('door-front');
    expect(realtime.emitAgent).toHaveBeenCalledTimes(1);
  });
});

describe('AgentsService.recordActivity', () => {
  it('clears offline alerts for an agent whose activity arrives as an event', async () => {
    // The bug this guards: events used to flip status back to online without
    // running recovery, leaving agent_offline unacknowledged forever — and the
    // dedup window would then suppress the next genuine offline alert.
    const { service, alerts, realtime } = await buildService();

    await service.recordActivity(agentRow({ status: AgentStatus.Offline }));

    expect(alerts.acknowledgeOpenOfflineAlerts).toHaveBeenCalledWith('door-front');
    expect(alerts.raiseAgentRecovered).toHaveBeenCalledTimes(1);
    expect(realtime.emitAgent).toHaveBeenCalledTimes(1);
  });

  it('marks the agent seen and online', async () => {
    const { service, prisma } = await buildService();

    await service.recordActivity(agentRow({ status: AgentStatus.Online }));

    const data = prisma.agent.update.mock.calls[0][0].data;
    expect(data.status).toBe(AgentStatus.Online);
    expect(data.lastSeenAt).toBeInstanceOf(Date);
  });
});

describe('AgentsService.findAll', () => {
  it('lists offline agents first so problems surface at the top', async () => {
    const { service, prisma } = await buildService();

    await service.findAll();

    // Postgres orders enums by declaration order (online, offline), so `desc`
    // puts offline first.
    expect(prisma.agent.findMany).toHaveBeenCalledWith({
      orderBy: [{ status: 'desc' }, { id: 'asc' }],
    });
  });
});

describe('AgentsService and the reserved browser namespace', () => {
  it('refuses to enroll an id in the browser-camera namespace', async () => {
    // Without this, a holder of the bootstrap key could enroll `browser-abc123` from the
    // device path and produce a feed the UI labels browser-origin while it is nothing of
    // the kind — or collide with a live session and rotate its token out from under it.
    const { service } = await buildService();

    await expect(
      service.register({ id: 'browser-abc123', type: 'camera', location: 'Lobby' }),
    ).rejects.toThrow(/reserved/i);
  });

  it('still allows an ordinary id that merely contains the word', async () => {
    const { service } = await buildService();

    await expect(
      service.register({ id: 'lobby-browser-cam', type: 'camera', location: 'Lobby' }),
    ).resolves.toBeTruthy();
  });
});
