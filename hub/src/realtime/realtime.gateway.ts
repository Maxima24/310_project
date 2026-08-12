import {
  WS_AGENT,
  WS_ALERT,
  WS_EVENT,
  WS_MODE,
  type AgentView,
  type AlertView,
  type EventView,
  type SystemModeResponse,
} from '@cpe310/contracts';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import { keyMatches } from '../common/security/compare-key';

/**
 * The @WebSocketGateway decorator is evaluated at class-definition time, long
 * before Nest's DI container exists, so CORS cannot come from ConfigService and
 * has to be read from the raw environment here.
 */
function corsOrigin(): string | string[] {
  const raw = process.env.CORS_ORIGIN?.trim();
  if (!raw || raw === '*') return '*';
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Live feed for dashboards. Deliberately depends on nothing but config: every
 * other module imports RealtimeModule and calls the emit* methods, which keeps
 * the dependency graph acyclic (events -> alerts -> realtime, agents -> realtime).
 */
@WebSocketGateway({
  cors: { origin: corsOrigin() },
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server: Server;

  constructor(private readonly config: ConfigService) {}

  /**
   * Nest guards do not run on socket.io handshakes, so auth happens here using
   * the same constant-time comparison the HTTP guard uses.
   */
  handleConnection(client: Socket): void {
    const provided = client.handshake.auth?.key ?? client.handshake.headers['x-agent-key'];
    const expected = this.config.get<string>('agentApiKey');

    if (!expected || !keyMatches(provided, expected)) {
      this.logger.warn(
        `Rejected WebSocket ${client.id} from ${client.handshake.address}: ` +
          (provided ? 'bad key' : 'no auth.key in handshake'),
      );
      // `true` closes the underlying connection rather than just the namespace,
      // so a client with a bad key cannot sit there retrying on the same socket.
      client.disconnect(true);
      return;
    }

    this.logger.log(`WebSocket client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`WebSocket client disconnected: ${client.id}`);
  }

  emitEvent(event: EventView): void {
    this.emit(WS_EVENT, event);
  }

  emitAlert(alert: AlertView): void {
    this.emit(WS_ALERT, alert);
  }

  emitMode(mode: SystemModeResponse): void {
    this.emit(WS_MODE, mode);
  }

  emitAgent(agent: AgentView): void {
    this.emit(WS_AGENT, agent);
  }

  private emit(channel: string, payload: unknown): void {
    // `server` is undefined until the gateway is initialised (and in unit tests
    // that never boot a socket server). A dropped broadcast must never fail the
    // HTTP request or the liveness sweep that triggered it.
    if (!this.server) {
      this.logger.debug(`Dropping "${channel}" broadcast — socket server not ready`);
      return;
    }
    this.server.emit(channel, payload);
  }
}
