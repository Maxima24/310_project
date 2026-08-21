import { AgentOrigin, AgentStatus, AlertType, type AgentType } from '@cpe310/contracts';
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

  /** Whether the one-shot post-boot reconciliation has run. */
  private reconciled = false;

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
   * Raises the missing alert for any agent already marked offline that has no open
   * `agent_offline` alert. Runs once, on the first sweep after the grace period.
   *
   * Closes a real gap. The sweep flips a whole batch to offline in one transaction
   * and then raises alerts one agent at a time, so a hub that dies mid-loop leaves
   * later agents marked offline with no alert ever raised. The routine sweep cannot
   * repair that, because it only ever looks at agents whose status is still `online`
   * — those agents would stay silently offline forever, which is precisely the
   * failure this system exists to prevent.
   *
   * Agents that have since come back are unaffected: they were flipped to `online`
   * by their own heartbeat during the grace period, so they no longer match.
   */
  private async reconcileOfflineAgents(): Promise<void> {
    try {
      const offline = await this.prisma.agent.findMany({
        where: {
          status: AgentStatus.Offline,
          // Devices only — see the note on the sweep predicate below.
          origin: AgentOrigin.Device,
          // No unacknowledged offline alert on record for this agent.
          alerts: {
            none: { type: AlertType.AgentOffline, acknowledged: false },
          },
        },
        select: { id: true, type: true, location: true, lastSeenAt: true },
      });

      if (offline.length === 0) return;

      this.logger.warn(
        `Reconciling ${offline.length} agent(s) left offline without an alert ` +
          '(previous hub instance likely stopped mid-sweep)',
      );

      for (const agent of offline) {
        await this.alerts.raiseAgentOffline(
          { id: agent.id, type: agent.type, location: agent.location },
          Date.now() - agent.lastSeenAt.getTime(),
        );
      }
    } catch (error) {
      // Reconciliation is best-effort; the routine sweep must still run.
      this.logger.error(`Offline reconciliation failed: ${(error as Error).message}`);
    }
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
    // twice on the same agent. Claimed before any awaiting work below — including
    // reconciliation — or a sweep would yield before holding the lock.
    if (this.sweeping) {
      this.logger.warn('Previous liveness sweep still running — skipping this tick');
      return;
    }
    this.sweeping = true;

    const timeoutMs = this.timeoutMs;
    const cutoff = new Date(now - timeoutMs);

    try {
      // Repairs state left inconsistent by a hub that died mid-sweep. Runs before
      // the normal pass so a genuinely dead agent is never left silently offline.
      if (!this.reconciled) {
        this.reconciled = true;
        await this.reconcileOfflineAgents();
      }

      let stale: StaleAgent[];

      try {
        stale = await this.prisma.$transaction(async (tx) => {
          const rows = await tx.agent.findMany({
            where: {
              status: AgentStatus.Online,
              lastSeenAt: { lt: cutoff },
              // DEVICES ONLY. The sweep's whole premise is that silence from a device
              // implies something is wrong with it — unplugged, tampered with, crashed.
              // That premise does not hold for a browser tab: browsers throttle timers
              // in a backgrounded tab and stop them outright when it is discarded, so a
              // browser camera goes quiet as a matter of routine. Sweeping it would
              // raise agent_offline and agent_recovered forever, training operators to
              // ignore the one alert that means tampering. Its `streaming: false` in
              // GET /cameras is the correct and sufficient signal.
              origin: AgentOrigin.Device,
            },
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
