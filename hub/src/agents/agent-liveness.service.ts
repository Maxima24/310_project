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

  /** Wall-clock time the hub started, used for the startup grace period below. */
  private bootedAt = Date.now();

  /** Guards against a slow sweep overlapping the next scheduled tick. */
  private sweeping = false;

  /**
   * Registered imperatively rather than with @Cron because the schedule is
   * configurable — a decorator argument cannot read ConfigService.
   */
  onModuleInit(): void {
    this.bootedAt = Date.now();

    const cron = this.config.get<string>('liveness.sweepCron') ?? '*/5 * * * * *';
    const job = new CronJob(cron, () => {
      void this.sweep();
    });

    this.scheduler.addCronJob(SWEEP_JOB, job);
    job.start();

    this.logger.log(
      `Liveness sweep scheduled (${cron}); offline after ${this.timeoutMs}ms of silence ` +
        `(first ${this.timeoutMs}ms of uptime are a grace period)`,
    );
  }

  private get timeoutMs(): number {
    return this.config.get<number>('liveness.timeoutMs') ?? 30_000;
  }

  /**
   * True while the hub has been up for less than one heartbeat timeout.
   *
   * Every agent's `lastSeenAt` is stale immediately after a hub restart, because
   * the hub was not running to receive heartbeats. Sweeping in that window
   * declares the entire healthy fleet tampered-with, raises an alert per agent,
   * and then clears them all again seconds later as the heartbeats land — the exact
   * storm observed on the first Docker run.
   *
   * Waiting one full timeout costs nothing in detection latency: a live agent beats
   * every HEARTBEAT_INTERVAL_MS, which env validation guarantees is shorter than the
   * timeout, so anything genuinely absent is still caught on the first real sweep.
   */
  private inStartupGrace(now: number): boolean {
    return now - this.bootedAt < this.timeoutMs;
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
    const now = Date.now();

    if (this.inStartupGrace(now)) {
      this.logger.debug('Skipping sweep — within startup grace period');
      return;
    }

    // A sweep slowed by a busy database must not overlap the next tick and alert
    // twice on the same agent.
    if (this.sweeping) {
      this.logger.warn('Previous liveness sweep still running — skipping this tick');
      return;
    }
    this.sweeping = true;

    const timeoutMs = this.timeoutMs;
    const cutoff = new Date(now - timeoutMs);

    try {
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

        try {
          await this.alerts.raiseAgentOffline(
            { id: agent.id, type: agent.type, location: agent.location },
            silentForMs,
          );

          const full = await this.prisma.agent.findUnique({ where: { id: agent.id } });
          if (full) this.realtime.emitAgent(toAgentView(full));
        } catch (error) {
          // One agent failing to alert must not abandon the rest of the batch —
          // the others are already marked offline and would never be reported.
          this.logger.error(
            `Failed to raise agent_offline for ${agent.id}: ${(error as Error).message}`,
          );
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
}
