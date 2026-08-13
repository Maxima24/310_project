import {
  AlertType,
  type AlertView,
  type QueryAlertsRequest,
  type SystemMode,
} from '@cpe310/contracts';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Alert, Prisma } from '@prisma/client';

import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SystemService } from '../system/system.service';
import { evaluate, offlineOutcome, recoveredOutcome, type RuleAgent, type RuleOutcome } from './alert-rules';

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly system: SystemService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  private get cooldownMs(): number {
    return this.config.get<number>('alerts.cooldownMs') ?? 60_000;
  }

  private get defaultLimit(): number {
    return this.config.get<number>('pagination.defaultLimit') ?? 50;
  }

  private get maxLimit(): number {
    return this.config.get<number>('pagination.maxLimit') ?? 200;
  }

  /**
   * Runs the rule table against one ingested event. Returns the alert if one was
   * raised, or null when the rules said nothing or the cooldown suppressed it.
   */
  async evaluateEvent(
    agent: RuleAgent,
    eventType: Parameters<typeof evaluate>[0]['eventType'],
    eventId: string,
  ): Promise<AlertView | null> {
    const { mode } = await this.system.getMode();
    const outcome = evaluate({ eventType, mode, agent });
    if (!outcome) return null;

    return this.raise(outcome, mode, { agentId: agent.id, eventId });
  }

  /** Called by the liveness sweep for each agent that went silent. */
  async raiseAgentOffline(agent: RuleAgent, silentForMs: number): Promise<AlertView | null> {
    const { mode } = await this.system.getMode();
    return this.raise(offlineOutcome(agent, mode, silentForMs), mode, { agentId: agent.id });
  }

  /** Called when a previously-offline agent reports in again. */
  async raiseAgentRecovered(agent: RuleAgent): Promise<AlertView | null> {
    const { mode } = await this.system.getMode();
    // Bypasses the cooldown: a recovery notice is the counterpart to a specific
    // offline alert, and suppressing it would leave a dashboard showing an agent
    // as offline with no event explaining the change.
    return this.raise(recoveredOutcome(agent), mode, { agentId: agent.id }, { skipCooldown: true });
  }

  /**
   * Persist -> broadcast -> notify, with dedup in front.
   *
   * Order matters: the row is committed before the WebSocket frame goes out, so a
   * dashboard can never receive an alert that `GET /alerts` does not yet return.
   */
  private async raise(
    outcome: RuleOutcome,
    mode: SystemMode,
    links: { agentId?: string; eventId?: string },
    options: { skipCooldown?: boolean } = {},
  ): Promise<AlertView | null> {
    if (!options.skipCooldown && (await this.isSuppressed(outcome.type, links.agentId))) {
      this.logger.debug(
        `Suppressed duplicate ${outcome.type} for ${links.agentId ?? 'system'} (within cooldown)`,
      );
      return null;
    }

    const alert = await this.prisma.alert.create({
      data: {
        type: outcome.type,
        severity: outcome.severity,
        message: outcome.message,
        modeAtTrigger: mode,
        agentId: links.agentId ?? null,
        eventId: links.eventId ?? null,
      },
    });

    const view = toAlertView(alert);
    this.logger.warn(`ALERT [${view.severity}] ${view.type}: ${view.message}`);
    this.realtime.emitAlert(view);
    this.notify(view);

    return view;
  }

  /**
   * True when an unacknowledged alert of the same (type, agent) was raised inside
   * the cooldown window. This is what stops a motion sensor polling once a second
   * from producing sixty alerts a minute.
   *
   * Acknowledged alerts do NOT suppress: once a human has seen and cleared an
   * alert, the next trip is genuinely new information.
   */
  private async isSuppressed(type: AlertType, agentId?: string): Promise<boolean> {
    const cooldown = this.cooldownMs;
    if (cooldown <= 0) return false;

    const existing = await this.prisma.alert.findFirst({
      where: {
        type,
        agentId: agentId ?? null,
        acknowledged: false,
        createdAt: { gte: new Date(Date.now() - cooldown) },
      },
      select: { id: true },
    });

    return existing !== null;
  }

  async findMany(query: QueryAlertsRequest): Promise<AlertView[]> {
    const limit = Math.min(query.limit ?? this.defaultLimit, this.maxLimit);

    const where: Prisma.AlertWhereInput = {};
    if (query.acknowledged !== undefined) where.acknowledged = query.acknowledged;
    if (query.type) where.type = query.type;
    if (query.agentId) where.agentId = query.agentId;

    const alerts = await this.prisma.alert.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return alerts.map(toAlertView);
  }

  /**
   * Idempotent: acknowledging an already-acknowledged alert succeeds and keeps
   * the original timestamp, so a double-click in a dashboard is harmless.
   */
  async acknowledge(id: string): Promise<AlertView> {
    const existing = await this.prisma.alert.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Alert ${id} not found`);
    if (existing.acknowledged) return toAlertView(existing);

    const updated = await this.prisma.alert.update({
      where: { id },
      data: { acknowledged: true, acknowledgedAt: new Date() },
    });

    const view = toAlertView(updated);
    this.realtime.emitAlert(view);
    return view;
  }

  /**
   * Auto-acknowledges an agent's open offline alerts. Called on recovery: without
   * it a flapping agent accumulates unacknowledged offline alerts forever, and the
   * cooldown then suppresses every genuinely new one.
   *
   * Returns how many were cleared.
   */
  async acknowledgeOpenOfflineAlerts(agentId: string): Promise<number> {
    const { count } = await this.prisma.alert.updateMany({
      where: { agentId, type: AlertType.AgentOffline, acknowledged: false },
      data: { acknowledged: true, acknowledgedAt: new Date() },
    });
    return count;
  }

  /**
   * Notification fan-out (roadmap item 3, implemented).
   *
   * Deliberately fire-and-forget: an SMTP handshake or a slow webhook must not delay
   * event ingestion, and the alert is already persisted and broadcast by this point,
   * so a delivery failure cannot lose it. Retries and per-channel outcomes are the
   * dispatcher's job, recorded in the Notification table.
   */
  private notify(alert: AlertView): void {
    void this.notifications.dispatch(alert).catch((error: unknown) => {
      this.logger.error(
        `Notification dispatch failed for ${alert.id}: ${(error as Error).message}`,
      );
    });
  }
}

/** Prisma row -> wire shape. Dates become ISO strings; nothing else changes. */
export function toAlertView(alert: Alert): AlertView {
  return {
    id: alert.id,
    type: alert.type,
    severity: alert.severity,
    message: alert.message,
    agentId: alert.agentId,
    eventId: alert.eventId,
    modeAtTrigger: alert.modeAtTrigger,
    acknowledged: alert.acknowledged,
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    createdAt: alert.createdAt.toISOString(),
  };
}
