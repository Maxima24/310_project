import { AuthRole } from '@cpe310/contracts';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import type { Identity } from '../security/credential.service';
import { CredentialService } from '../security/credential.service';
import { extractBearer, redact } from '../security/tokens';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ROLES_KEY } from './roles.decorator';

/** Requests carry their resolved identity so controllers need not re-parse the header. */
export interface AuthenticatedRequest extends Request {
  identity?: Identity;
}

/**
 * Role-based auth for every HTTP route (roadmap item 2).
 *
 * Replaces the single shared `x-agent-key`, under which any key holder could forge
 * an event as any sensor, disarm the system, and acknowledge alerts. Now:
 *
 *   - the bootstrap key can only enroll agents,
 *   - an agent token can only speak for its own agent,
 *   - only the operator credential can arm/disarm, acknowledge, or read history.
 *
 * Routes with no @Roles decorator require Operator, so anything added later is
 * locked down by default rather than accidentally reachable by a sensor token.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly credentials: CredentialService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // WebSocket handshakes bypass Nest guards; RealtimeGateway authenticates itself
    // using the same CredentialService.
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const credential = extractBearer(request.headers.authorization);

    if (!credential) {
      this.logger.warn(
        `Rejected ${request.method} ${request.originalUrl}: no Authorization: Bearer header`,
      );
      throw new UnauthorizedException('Missing Authorization: Bearer <credential> header');
    }

    const identity = await this.credentials.resolve(credential);
    if (!identity) {
      this.logger.warn(
        `Rejected ${request.method} ${request.originalUrl}: unknown credential ${redact(credential)}`,
      );
      throw new UnauthorizedException('Invalid credential');
    }

    request.identity = identity;

    const allowed =
      this.reflector.getAllAndOverride<AuthRole[]>(ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [AuthRole.Operator];

    if (!allowed.includes(identity.role)) {
      this.logger.warn(
        `Rejected ${request.method} ${request.originalUrl}: role "${identity.role}" ` +
          `not in [${allowed.join(', ')}]`,
      );
      throw new ForbiddenException(
        `This endpoint requires one of: ${allowed.join(', ')} (you are ${identity.role})`,
      );
    }

    if (identity.role === AuthRole.Agent) {
      this.assertActingAsSelf(request, identity);
    }

    return true;
  }

  /**
   * An agent token may only act for its own agent.
   *
   * This is the concrete win of roadmap item 2: previously a single compromised
   * sensor could inject a `door_closed` for the front door to mask an intrusion, or
   * fake heartbeats for a sensor it had physically disabled. The agent id appears in
   * the path (`/agents/:id/heartbeat`) or the body (`/events`), and both must match
   * the token's owner.
   */
  private assertActingAsSelf(request: AuthenticatedRequest, identity: Identity): void {
    const claimed =
      (request.params as Record<string, string> | undefined)?.id ??
      (request.body as { agentId?: unknown } | undefined)?.agentId;

    if (claimed === undefined || claimed === null) return;

    if (typeof claimed !== 'string' || claimed !== identity.agentId) {
      this.logger.warn(
        `Agent ${identity.agentId} attempted to act as "${String(claimed)}" ` +
          `on ${request.method} ${request.originalUrl}`,
      );
      throw new ForbiddenException(
        `Agent token for "${identity.agentId}" cannot act as "${String(claimed)}"`,
      );
    }
  }
}
