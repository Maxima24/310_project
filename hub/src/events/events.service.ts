import type {
  AlertView,
  CreateEventRequest,
  EventMetadata,
  EventView,
  QueryEventsRequest,
} from '@cpe310/contracts';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Event, Prisma } from '@prisma/client';

import { AgentsService } from '../agents/agents.service';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export interface IngestResult {
  event: EventView;
  /** The alert this event raised, or null if the rules stayed silent. */
  alert: AlertView | null;
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agents: AgentsService,
    private readonly alerts: AlertsService,
    private readonly realtime: RealtimeGateway,
    private readonly config: ConfigService,
  ) {}

  private get defaultLimit(): number {
    return this.config.get<number>('pagination.defaultLimit') ?? 50;
  }

  private get maxLimit(): number {
    return this.config.get<number>('pagination.maxLimit') ?? 200;
  }

  /**
   * Ingest one sensor observation.
   *
   * Step order is deliberate:
   *   1. Reject unknown agents — an unregistered sensor has no type or location
   *      to evaluate rules against, and auto-creating one would turn a typo'd
   *      `--id` into a phantom sensor nobody is monitoring.
   *   2. Touch lastSeenAt: an event is proof of life, so a busy sensor is never
   *      swept offline mid-report.
   *   3. Persist, then broadcast — never the reverse, or a dashboard could receive
   *      an event that `GET /events` does not yet return.
   *   4. Evaluate rules last, so a failure in alerting cannot lose the event.
   */
  async ingest(dto: CreateEventRequest): Promise<IngestResult> {
    const agent = await this.agents.findOne(dto.agentId);
    if (!agent) {
      throw new NotFoundException(
        `Agent ${dto.agentId} is not registered — POST /agents/register first`,
      );
    }

    await this.agents.touch(agent.id);

    const created = await this.prisma.event.create({
      data: {
        agentId: agent.id,
        type: dto.type,
        occurredAt: new Date(dto.occurredAt),
        metadata: (dto.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });

    const view = toEventView(created);
    this.logger.debug(`Event ${view.type} from ${view.agentId}`);
    this.realtime.emitEvent(view);

    const alert = await this.alerts.evaluateEvent(
      { id: agent.id, type: agent.type, location: agent.location },
      dto.type,
      created.id,
    );

    return { event: view, alert };
  }

  async findMany(query: QueryEventsRequest): Promise<EventView[]> {
    const limit = Math.min(query.limit ?? this.defaultLimit, this.maxLimit);

    const where: Prisma.EventWhereInput = {};
    if (query.agentId) where.agentId = query.agentId;
    if (query.type) where.type = query.type;
    if (query.since) where.createdAt = { gt: new Date(query.since) };

    const events = await this.prisma.event.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return events.map(toEventView);
  }
}

export function toEventView(event: Event): EventView {
  return {
    id: event.id,
    agentId: event.agentId,
    type: event.type,
    metadata: (event.metadata ?? {}) as EventMetadata,
    occurredAt: event.occurredAt.toISOString(),
    createdAt: event.createdAt.toISOString(),
  };
}
