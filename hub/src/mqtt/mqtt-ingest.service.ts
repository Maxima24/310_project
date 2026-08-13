import { AuthRole, EventType } from '@cpe310/contracts';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mqtt, { type MqttClient } from 'mqtt';

import { AgentsService } from '../agents/agents.service';
import { CredentialService } from '../common/security/credential.service';
import { EventsService } from '../events/events.service';

/** Mirrors the REST paths so routing reads the same on both transports. */
const EVENT_TOPIC = 'cpe310/agents/+/events';
const HEARTBEAT_TOPIC = 'cpe310/agents/+/heartbeat';

@Injectable()
export class MqttIngestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttIngestService.name);
  private client?: MqttClient;

  constructor(
    private readonly config: ConfigService,
    private readonly credentials: CredentialService,
    private readonly events: EventsService,
    private readonly agents: AgentsService,
  ) {}

  onModuleInit(): void {
    const url = this.config.get<string>('mqtt.url');
    if (!url) {
      // Absent config means "HTTP only", which is the default. Not an error.
      this.logger.log('MQTT ingestion disabled (no MQTT_URL configured)');
      return;
    }

    this.client = mqtt.connect(url, {
      clientId: `cpe310-hub-${process.pid}`,
      reconnectPeriod: 5_000,
      // The hub is a subscriber, so a clean session is fine: anything published while
      // it was down is genuinely lost, which is what the agents' local buffering and
      // the liveness sweep exist to cover.
      clean: true,
    });

    this.client.on('connect', () => {
      this.logger.log(`Connected to MQTT broker at ${url}`);
      this.client?.subscribe([EVENT_TOPIC, HEARTBEAT_TOPIC], { qos: 1 }, (error) => {
        if (error) this.logger.error(`MQTT subscribe failed: ${error.message}`);
        else this.logger.log(`Subscribed to ${EVENT_TOPIC} and ${HEARTBEAT_TOPIC}`);
      });
    });

    this.client.on('message', (topic, payload) => {
      void this.handle(topic, payload).catch((error: unknown) => {
        // One malformed message must not tear down ingestion for the whole fleet.
        this.logger.error(`MQTT message on ${topic} failed: ${(error as Error).message}`);
      });
    });

    this.client.on('error', (error) => this.logger.error(`MQTT error: ${error.message}`));
    this.client.on('reconnect', () => this.logger.warn('Reconnecting to MQTT broker'));
  }

  onModuleDestroy(): void {
    this.client?.end(true);
  }

  /**
   * Routes one MQTT message through the same services the REST controllers use, so
   * alert rules, dedup, liveness, and the WebSocket feed behave identically on both
   * transports. A second implementation of ingestion would be a second place for the
   * rules to drift.
   */
  private async handle(topic: string, payload: Buffer): Promise<void> {
    const match = /^cpe310\/agents\/([^/]+)\/(events|heartbeat)$/.exec(topic);
    if (!match) {
      this.logger.warn(`Ignoring message on unexpected topic ${topic}`);
      return;
    }

    const [, topicAgentId, kind] = match;

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
    } catch {
      this.logger.warn(`Ignoring non-JSON payload on ${topic}`);
      return;
    }

    // The hub must establish WHICH agent published this. MQTT does not surface the
    // publisher's username to subscribers, so the topic alone is not evidence — on a
    // shared bus any publisher could put another agent's id in it. The token in the
    // payload is the same proof the HTTP Authorization header provides, resolved
    // through the same CredentialService as HTTP and WebSocket.
    //
    // Required, not optional: a check that can be skipped by omitting a field is not
    // a check.
    const token = typeof body.token === 'string' ? body.token : undefined;
    if (!token) {
      this.logger.warn(`Rejected MQTT ${kind} on ${topic}: payload carries no token`);
      return;
    }

    const identity = await this.credentials.resolve(token);
    if (!identity || identity.role !== AuthRole.Agent) {
      this.logger.warn(`Rejected MQTT ${kind} on ${topic}: token is not a valid agent token`);
      return;
    }

    if (identity.agentId !== topicAgentId) {
      this.logger.warn(
        `Rejected MQTT ${kind}: token for ${identity.agentId} published as ${topicAgentId}`,
      );
      return;
    }

    const agent = await this.agents.findOne(topicAgentId);
    if (!agent) {
      this.logger.warn(`Ignoring MQTT ${kind} from unregistered agent ${topicAgentId}`);
      return;
    }

    if (kind === 'heartbeat') {
      await this.agents.recordActivity(agent);
      return;
    }

    const type = body.type as EventType;
    if (!Object.values(EventType).includes(type)) {
      this.logger.warn(`Ignoring MQTT event with unknown type ${String(body.type)}`);
      return;
    }

    await this.events.ingest({
      agentId: topicAgentId,
      type,
      occurredAt:
        typeof body.occurredAt === 'string' ? body.occurredAt : new Date().toISOString(),
      metadata: (body.metadata as Record<string, unknown> | undefined) ?? {},
    });
  }
}
