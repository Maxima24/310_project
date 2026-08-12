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

  const service = moduleRef.get(AgentLivenessService);

  // Pretend the hub has been up for a while. `bootedAt` is set at construction, so
  // a freshly built service is always inside its startup grace period — every test
  // below except the grace-period ones needs a warm hub to exercise the sweep.
  warmUp(service);

  return { service, prisma, agentDelegate, alerts, realtime };
}

/** Backdates the service's boot time past the grace period. */
function warmUp(service: AgentLivenessService, msAgo = TIMEOUT_MS * 2): void {
  (service as unknown as { bootedAt: number }).bootedAt = Date.now() - msAgo;
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

  it('keeps sweeping the batch when one agent fails to alert', async () => {
    // The whole batch is already marked offline, so bailing on the first failure
    // would leave the rest silently unreported.
    const { service, alerts } = await buildService([
      { id: 'door-front', type: 'door', location: 'Front door', lastSeenAt: new Date(Date.now() - 40_000) },
      { id: 'motion-hallway', type: 'motion', location: 'Hallway', lastSeenAt: new Date(Date.now() - 40_000) },
    ]);
    alerts.raiseAgentOffline.mockRejectedValueOnce(new Error('alert insert failed'));

    await expect(service.sweep()).resolves.toBeUndefined();
    expect(alerts.raiseAgentOffline).toHaveBeenCalledTimes(2);
  });
});

describe('AgentLivenessService startup grace period', () => {
  it('does not sweep while the hub has been up for less than one timeout', async () => {
    // Every agent's lastSeenAt is stale right after a restart, because the hub was
    // not running to receive heartbeats. Sweeping here would declare the entire
    // healthy fleet tampered-with and then clear it seconds later.
    const { service, agentDelegate, alerts } = await buildService([
      { id: 'door-front', type: 'door', location: 'Front door', lastSeenAt: new Date(Date.now() - 600_000) },
    ]);
    warmUp(service, 0); // just booted

    await service.sweep();

    expect(agentDelegate.findMany).not.toHaveBeenCalled();
    expect(alerts.raiseAgentOffline).not.toHaveBeenCalled();
  });

  it('sweeps normally once the grace period has elapsed', async () => {
    const { service, alerts } = await buildService([
      { id: 'door-front', type: 'door', location: 'Front door', lastSeenAt: new Date(Date.now() - 600_000) },
    ]);
    warmUp(service, TIMEOUT_MS + 1_000);

    await service.sweep();

    expect(alerts.raiseAgentOffline).toHaveBeenCalledTimes(1);
  });
});

describe('AgentLivenessService re-entrancy', () => {
  it('skips a tick rather than overlapping a sweep that is still running', async () => {
    const { service, prisma, alerts } = await buildService([
      { id: 'door-front', type: 'door', location: 'Front door', lastSeenAt: new Date(Date.now() - 40_000) },
    ]);

    // Hold the transaction open so the second call arrives mid-sweep.
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    prisma.$transaction.mockImplementationOnce(async () => {
      await blocked;
      return [];
    });

    const first = service.sweep();
    await service.sweep(); // must return immediately, not alert
    release();
    await first;

    expect(alerts.raiseAgentOffline).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('clears the re-entrancy flag after a failure so later ticks still run', async () => {
    const { service, prisma } = await buildService([]);
    prisma.$transaction.mockRejectedValueOnce(new Error('connection reset'));

    await service.sweep();
    await service.sweep();

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});
