import {
  AgentStatus,
  type AgentAckResponse,
  type AgentView,
  type RegisterAgentRequest,
} from '@cpe310/contracts';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Agent } from '@prisma/client';

import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly alerts: AlertsService,
    private readonly config: ConfigService,
  ) {}

  private get heartbeatIntervalMs(): number {
    return this.config.get<number>('liveness.heartbeatIntervalMs') ?? 10_000;
  }

  /**
   * Upsert, not create: an agent restart must land on the same row so its event
   * history survives and a stale `offline` status is cleared. Registration is
   * therefore idempotent and safe to retry, which the Python transport relies on.
   */
  async register(dto: RegisterAgentRequest): Promise<AgentAckResponse> {
    const previous = await this.prisma.agent.findUnique({ where: { id: dto.id } });

    const agent = await this.prisma.agent.upsert({
      where: { id: dto.id },
      create: {
        id: dto.id,
        type: dto.type,
        location: dto.location,
        version: dto.version ?? null,
        capabilities: dto.capabilities ?? [],
        status: AgentStatus.Online,
      },
      update: {
        // Type/location can legitimately change if a sensor is physically moved.
        type: dto.type,
        location: dto.location,
        // Only overwrite when supplied. A caller that re-registers with a minimal
        // payload should not silently wipe the version and capabilities the agent
        // reported earlier.
        ...(dto.version !== undefined ? { version: dto.version } : {}),
        ...(dto.capabilities !== undefined ? { capabilities: dto.capabilities } : {}),
        status: AgentStatus.Online,
        lastSeenAt: new Date(),
      },
    });

    this.logger.log(
      `${previous ? 'Re-registered' : 'Registered'} ${agent.type} agent ${agent.id} at ${agent.location}`,
    );

    if (previous?.status === AgentStatus.Offline) {
      await this.handleRecovery(agent);
    }

    const view = toAgentView(agent);
    this.realtime.emitAgent(view);

    return { agent: view, heartbeatIntervalMs: this.heartbeatIntervalMs };
  }

  /**
   * 404 on an unknown id rather than implicitly creating a row. The agent cannot
   * supply its type or location on a heartbeat, so a row invented here would be
   * incomplete — and the Python transport treats 404 as "re-register", which
   * recovers correctly even after the hub's database is wiped.
   */
  async heartbeat(id: string): Promise<AgentAckResponse> {
    const existing = await this.prisma.agent.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Agent ${id} is not registered — POST /agents/register first`);
    }

    const agent = await this.recordActivity(existing);

    return { agent: toAgentView(agent), heartbeatIntervalMs: this.heartbeatIntervalMs };
  }

  /**
   * Marks an agent seen and online, handling the offline -> online transition.
   *
   * Every activity path funnels through here — heartbeats AND events — because an
   * event is proof of life just as much as a heartbeat is. Routing recovery through
   * one method is what stops an agent that reports an event while marked offline
   * from being quietly flipped to online with its `agent_offline` alert left open
   * forever (which would then let the dedup window suppress the next real one).
   *
   * Takes the already-loaded row rather than an id so the caller's read is reused
   * and the previous status is known without a second query.
   */
  async recordActivity(previous: Agent): Promise<Agent> {
    const agent = await this.prisma.agent.update({
      where: { id: previous.id },
      data: { lastSeenAt: new Date(), status: AgentStatus.Online },
    });

    if (previous.status === AgentStatus.Offline) {
      await this.handleRecovery(agent);
      // Broadcast only on a state change; a healthy 10-agent fleet would otherwise
      // push a frame per second to every dashboard for no new information.
      this.realtime.emitAgent(toAgentView(agent));
    }

    return agent;
  }

  async findOne(id: string): Promise<Agent | null> {
    return this.prisma.agent.findUnique({ where: { id } });
  }

  async findAll(): Promise<AgentView[]> {
    const agents = await this.prisma.agent.findMany({
      // Offline first: Postgres orders an enum by declaration order, and
      // AgentStatus declares `online` before `offline`, so `desc` surfaces the
      // agents that need attention at the top of the list.
      orderBy: [{ status: 'desc' }, { id: 'asc' }],
    });
    // One `now` for the whole list so two agents seen in the same instant cannot
    // report different secondsSinceLastSeen.
    const now = Date.now();
    return agents.map((a) => toAgentView(a, now));
  }

  /**
   * An agent that was offline has reported in. Clear its open offline alerts and
   * post a recovery notice, so a dashboard sees the resolution instead of a row
   * silently flipping back to green.
   */
  private async handleRecovery(agent: Agent): Promise<void> {
    const cleared = await this.alerts.acknowledgeOpenOfflineAlerts(agent.id);
    this.logger.log(
      `Agent ${agent.id} recovered — auto-acknowledged ${cleared} open agent_offline alert(s)`,
    );
    await this.alerts.raiseAgentRecovered({
      id: agent.id,
      type: agent.type,
      location: agent.location,
    });
  }
}

export function toAgentView(agent: Agent, now: number = Date.now()): AgentView {
  return {
    id: agent.id,
    type: agent.type,
    location: agent.location,
    status: agent.status,
    version: agent.version,
    capabilities: agent.capabilities,
    registeredAt: agent.registeredAt.toISOString(),
    lastSeenAt: agent.lastSeenAt.toISOString(),
    secondsSinceLastSeen: Math.max(
      0,
      Math.round((now - agent.lastSeenAt.getTime()) / 1000),
    ),
  };
}
