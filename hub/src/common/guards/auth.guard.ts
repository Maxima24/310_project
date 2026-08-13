import { AuthRole, Permission } from '@cpe310/contracts';
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
import { PERMISSIONS_KEY } from './permissions.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';

/** Requests carry their resolved identity so controllers need not re-parse the header. */
export interface AuthenticatedRequest extends Request {
  identity?: Identity;
}

/**
 * Authentication plus the role-based half of authorization.
 *
 * Replaces the single shared key, under which any holder could forge an event as any
 * sensor, disarm the system, and acknowledge alerts. Now each credential resolves to a
 * role, each role carries a permission set, and each route declares the permissions it
 * needs.
 *
 * Attribute-based rules — disarming during an active incident, zone scoping — are NOT
 * here: they depend on database state and produce reasons a human should read, so they
 * live in PolicyService and are applied by the services that own the action.
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

    const required =
      this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (required.length === 0) {
      // Fail closed. A route with no declared permissions is a mistake, and treating
      // it as "anyone authenticated" is how a sensor token ends up able to disarm.
      this.logger.error(
        `${request.method} ${request.originalUrl} declares no required permissions — denying. ` +
          'Add @RequirePermissions(...) or @Public().',
      );
      throw new ForbiddenException('This endpoint is not accessible');
    }

    const missing = required.filter((permission) => !identity.permissions.includes(permission));
    if (missing.length > 0) {
      this.logger.warn(
        `Rejected ${request.method} ${request.originalUrl}: role "${identity.role}" ` +
          `lacks ${missing.join(', ')}`,
      );
      throw new ForbiddenException(
        `Requires ${missing.join(', ')} — the "${identity.role}" role does not have it.`,
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
   * Previously a single compromised sensor could inject a `door_closed` for the front
   * door to mask an intrusion, or fake heartbeats for a sensor it had physically
   * disabled. The agent id appears in the path (`/agents/:id/heartbeat`) or the body
   * (`/events`), and both must match the token's owner.
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
