import {
  Permission,
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

/** Clients with no zone restriction. */
const ROOM_UNRESTRICTED = 'scope:all';

/** Room for one zone. Lowercased so zone matching is case-insensitive, as elsewhere. */
function zoneRoom(location: string): string {
  return `zone:${location.toLowerCase()}`;
}

/**
 * Live feed for dashboards.
 *
 * Depends only on CredentialService: every other module imports RealtimeModule and
 * calls the emit* methods, which keeps the dependency graph acyclic (events -> alerts
 * -> realtime, agents -> realtime).
 *
 * Zone scoping is enforced here as well as in the REST queries. Without it a
 * zone-restricted viewer would be filtered out of `GET /events` but still receive every
 * event in the building over the socket, which would make the REST filtering
 * decorative. socket.io rooms do the fan-out: unrestricted clients join one room,
 * zone-restricted clients join a room per zone, and each broadcast targets the
 * unrestricted room plus the room for the originating location.
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

    // Permission-based, not role-based: any human role that may read alerts may watch
    // them arrive. Agents and the bootstrap key hold no read permissions, so they are
    // excluded without naming them — a compromised sensor still cannot watch the whole
    // building to time an intrusion.
    if (!identity.permissions.includes(Permission.AlertsRead)) {
      this.reject(
        client,
        `role "${identity.role}" cannot subscribe to the live feed (alerts:read required)`,
      );
      return;
    }

    if (identity.zones.length > 0) {
      await client.join(identity.zones.map(zoneRoom));
    } else {
      await client.join(ROOM_UNRESTRICTED);
    }

    this.logger.log(
      `WebSocket ${identity.role} connected: ${client.id}` +
        (identity.zones.length ? ` (zones: ${identity.zones.join(', ')})` : ''),
    );
  }

  handleDisconnect(client: Socket): void {
    // socket.io removes a disconnected socket from its rooms automatically.
    this.logger.log(`WebSocket client disconnected: ${client.id}`);
  }

  private reject(client: Socket, reason: string): void {
    this.logger.warn(`Rejected WebSocket ${client.id} from ${client.handshake.address}: ${reason}`);
    // `true` closes the underlying connection rather than just the namespace, so a
    // client with a bad credential cannot sit there retrying on the same socket.
    client.disconnect(true);
  }

  /**
   * `location` is the originating agent's location, used for zone fan-out. Omitting it
   * sends to unrestricted clients only — the safe default, since a payload with no
   * known location cannot be shown to be in anyone's zone.
   */
  emitEvent(event: EventView, location?: string): void {
    this.emitScoped(WS_EVENT, event, location);
  }

  emitAlert(alert: AlertView, location?: string): void {
    this.emitScoped(WS_ALERT, alert, location);
  }

  emitAgent(agent: AgentView): void {
    // AgentView already carries its location.
    this.emitScoped(WS_AGENT, agent, agent.location);
  }

  /** Arm state is system-wide, so every authorised client sees it regardless of zone. */
  emitMode(mode: SystemModeResponse): void {
    if (!this.ready()) return;
    this.server.emit(WS_MODE, mode);
  }

  private emitScoped(channel: string, payload: unknown, location?: string): void {
    if (!this.ready()) return;

    const rooms = location ? [ROOM_UNRESTRICTED, zoneRoom(location)] : [ROOM_UNRESTRICTED];
    // socket.io de-duplicates across rooms, so a client in both receives one copy.
    this.server.to(rooms).emit(channel, payload);
  }

  private ready(): boolean {
    // `server` is undefined until the gateway is initialised (and in unit tests that
    // never boot a socket server). A dropped broadcast must never fail the HTTP request
    // or the liveness sweep that triggered it.
    if (!this.server) {
      this.logger.debug('Dropping broadcast — socket server not ready');
      return false;
    }
    return true;
  }
}
