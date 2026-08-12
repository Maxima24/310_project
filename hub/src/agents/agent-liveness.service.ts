import { AgentStatus, type AgentType } from '@cpe310/contracts';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { toAgentView } from './agents.service';

const SWEEP_JOB = 'agent-liveness-sweep';

/** The subset of Agent the sweep needs to alert on. */
interface StaleAgent {
  id: string;
  type: AgentType;
  location: string;
  lastSeenAt: Date;
}

/**
 * Turns silence into an alert.
 *
 * This is the half of the system an agent cannot do for itself: a tampered or
 * unplugged sensor does not get to send a "going offline" message, so the hub has
 * to notice the absence.
 *
 * Timing: agents beat every HEARTBEAT_INTERVAL_MS (10s) and are declared offline
 * after HEARTBEAT_TIMEOUT_MS (30s, i.e. three missed beats) of silence. The sweep
 * runs on LIVENESS_SWEEP_CRON (every 5s), so worst-case detection latency is
 * timeout + sweep interval = 35s and typical is ~32s. Env validation enforces
 * timeout > interval, without which every healthy agent would be swept between beats.
 */
@Injectable()
export class AgentLivenessService implements OnModuleInit {
  private readonly logger = new Logger(AgentLivenessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    private readonly realtime: RealtimeGateway,
    private readonly config: ConfigService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  /**
   * Registered imperatively rather than with @Cron because the schedule is
   * configurable — a decorator argument cannot read ConfigService.
   */
  onModuleInit(): void {
    const cron = this.config.get<string>('liveness.sweepCron') ?? '*/5 * * * * *';
    const job = new CronJob(cron, () => {
      void this.sweep();
    });

    this.scheduler.addCronJob(SWEEP_JOB, job);
    job.start();

    this.logger.log(
      `Liveness sweep scheduled (${cron}); offline after ${this.timeoutMs}ms of silence`,
    );
  }

  private get timeoutMs(): number {
    return this.config.get<number>('liveness.timeoutMs') ?? 30_000;
  }

  /**
   * Finds agents that have gone quiet, flips them to offline, and raises one
   * alert each.
   *
   * The read and the write share a transaction because `updateMany` cannot return
   * the rows it touched: selecting first and updating inside the same transaction
   * is what guarantees each agent is alerted on exactly once, even if a sweep
   * overlaps the next one.
   */
  async sweep(): Promise<void> {
    const timeoutMs = this.timeoutMs;
    const cutoff = new Date(Date.now() - timeoutMs);

    let stale: StaleAgent[];

    try {
      stale = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.agent.findMany({
          where: { status: AgentStatus.Online, lastSeenAt: { lt: cutoff } },
          select: { id: true, type: true, location: true, lastSeenAt: true },
        });

        if (rows.length > 0) {
          await tx.agent.updateMany({
            where: { id: { in: rows.map((r) => r.id) } },
            data: { status: AgentStatus.Offline },
          });
        }

        return rows;
      });
    } catch (error) {
      // A sweep failure must not kill the scheduled job — the next tick retries.
      this.logger.error(`Liveness sweep failed: ${(error as Error).message}`);
      return;
    }

    for (const agent of stale) {
      const silentForMs = Date.now() - agent.lastSeenAt.getTime();
      this.logger.warn(
        `Agent ${agent.id} went offline (silent ${Math.round(silentForMs / 1000)}s)`,
      );

      await this.alerts.raiseAgentOffline(
        { id: agent.id, type: agent.type, location: agent.location },
        silentForMs,
      );

      const full = await this.prisma.agent.findUnique({ where: { id: agent.id } });
      if (full) this.realtime.emitAgent(toAgentView(full));
    }
  }
}
