import {
  AuthRole,
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
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import { CredentialService } from '../common/security/credential.service';
import { extractBearer, redact } from '../common/security/tokens';

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

  constructor(private readonly credentials: CredentialService) {}

  /**
   * Nest guards do not run on socket.io handshakes, so the gateway authenticates
   * itself — through the same CredentialService the HTTP guard uses, so there is one
   * implementation of "who is this?".
   *
   * The live feed carries every event and alert in the building, so it requires the
   * **operator** credential. An agent token is explicitly not enough: a compromised
   * sensor should not be able to watch the whole system to time an intrusion.
   */
  async handleConnection(client: Socket): Promise<void> {
    const provided =
      (client.handshake.auth?.key as string | undefined) ??
      extractBearer(client.handshake.headers.authorization) ??
      undefined;

    if (!provided) {
      this.reject(client, 'no auth.key in handshake');
      return;
    }

    const identity = await this.credentials.resolve(provided);

    if (!identity) {
      this.reject(client, `unknown credential ${redact(provided)}`);
      return;
    }

    if (identity.role !== AuthRole.Operator) {
      this.reject(
        client,
        `role "${identity.role}" cannot subscribe to the live feed (operator required)`,
      );
      return;
    }

    this.logger.log(`WebSocket operator connected: ${client.id}`);
  }

  private reject(client: Socket, reason: string): void {
    this.logger.warn(`Rejected WebSocket ${client.id} from ${client.handshake.address}: ${reason}`);
    // `true` closes the underlying connection rather than just the namespace, so a
    // client with a bad credential cannot sit there retrying on the same socket.
    client.disconnect(true);
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
