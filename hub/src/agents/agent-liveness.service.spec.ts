import { AgentStatus } from '@cpe310/contracts';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';

import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AgentLivenessService } from './agent-liveness.service';

const TIMEOUT_MS = 30_000;

interface AgentRow {
  id: string;
  type: 'motion' | 'door' | 'camera';
  location: string;
  lastSeenAt: Date;
}

/**
 * Mocks Prisma's transaction by running the callback against the same mock client,
 * which is enough to assert the sweep's read-then-update sequence and the exact
 * predicate it uses.
 */
async function buildService(staleRows: AgentRow[]) {
  const agentDelegate = {
    findMany: jest.fn().mockResolvedValue(staleRows),
    updateMany: jest.fn().mockResolvedValue({ count: staleRows.length }),
    findUnique: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
      const row = staleRows.find((r) => r.id === where.id);
      return Promise.resolve(
        row
          ? {
              ...row,
              status: AgentStatus.Offline,
              version: null,
              capabilities: [],
              registeredAt: row.lastSeenAt,
            }
          : null,
      );
    }),
  };

  const prisma = {
    agent: agentDelegate,
    $transaction: jest.fn((cb: (tx: unknown) => Promise<unknown>) => cb({ agent: agentDelegate })),
  };

  const alerts = {
    raiseAgentOffline: jest.fn().mockResolvedValue(null),
  };
  const realtime = { emitAgent: jest.fn() };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'liveness.timeoutMs') return TIMEOUT_MS;
      if (key === 'liveness.sweepCron') return '*/5 * * * * *';
      return undefined;
    }),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      AgentLivenessService,
      { provide: PrismaService, useValue: prisma },
      { provide: AlertsService, useValue: alerts },
      { provide: RealtimeGateway, useValue: realtime },
      { provide: ConfigService, useValue: config },
      { provide: SchedulerRegistry, useValue: { addCronJob: jest.fn() } },
    ],
  }).compile();

  return { service: moduleRef.get(AgentLivenessService), prisma, agentDelegate, alerts, realtime };
}

describe('AgentLivenessService.sweep', () => {
  it('flips a silent agent to offline and raises exactly one alert', async () => {
    const silentFor = 32_000;
    const { service, agentDelegate, alerts, realtime } = await buildService([
      { id: 'door-front', type: 'door', location: 'Front door', lastSeenAt: new Date(Date.now() - silentFor) },
    ]);

    await service.sweep();

    expect(agentDelegate.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['door-front'] } },
      data: { status: AgentStatus.Offline },
    });
    expect(alerts.raiseAgentOffline).toHaveBeenCalledTimes(1);
    expect(realtime.emitAgent).toHaveBeenCalledTimes(1);

    const [ruleAgent, reportedSilentMs] = alerts.raiseAgentOffline.mock.calls[0];
    expect(ruleAgent).toEqual({ id: 'door-front', type: 'door', location: 'Front door' });
    // Location and type must reach the rules — the alert message needs them.
    expect(reportedSilentMs).toBeGreaterThanOrEqual(silentFor);
  });

  it('queries only online agents past the timeout cutoff', async () => {
    const { service, agentDelegate } = await buildService([]);
    const before = Date.now();

    await service.sweep();

    const where = agentDelegate.findMany.mock.calls[0][0].where;
    expect(where.status).toBe(AgentStatus.Online);
    // A fresh agent is excluded by the cutoff, and an already-offline agent by the
    // status filter — that filter is what stops the sweep re-alerting every 5s.
    const cutoff = where.lastSeenAt.lt as Date;
    expect(cutoff.getTime()).toBeLessThanOrEqual(before - TIMEOUT_MS + 5);
  });

  it('writes and alerts nothing when every agent is healthy', async () => {
    const { service, agentDelegate, alerts, realtime } = await buildService([]);

    await service.sweep();

    expect(agentDelegate.updateMany).not.toHaveBeenCalled();
    expect(alerts.raiseAgentOffline).not.toHaveBeenCalled();
    expect(realtime.emitAgent).not.toHaveBeenCalled();
  });

  it('alerts once per stale agent when several go silent together', async () => {
    const { service, alerts } = await buildService([
      { id: 'door-front', type: 'door', location: 'Front door', lastSeenAt: new Date(Date.now() - 40_000) },
      { id: 'motion-hallway', type: 'motion', location: 'Hallway', lastSeenAt: new Date(Date.now() - 50_000) },
    ]);

    await service.sweep();

    expect(alerts.raiseAgentOffline).toHaveBeenCalledTimes(2);
  });

  it('swallows a database failure so the scheduled job survives to the next tick', async () => {
    const { service, prisma, alerts } = await buildService([]);
    prisma.$transaction.mockRejectedValue(new Error('connection reset'));

    await expect(service.sweep()).resolves.toBeUndefined();
    expect(alerts.raiseAgentOffline).not.toHaveBeenCalled();
  });
});
