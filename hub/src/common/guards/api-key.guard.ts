import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { keyMatches } from '../security/compare-key';
import { IS_PUBLIC_KEY } from './public.decorator';

export const API_KEY_HEADER = 'x-agent-key';

/**
 * Shared-secret auth for every HTTP route. Registered globally via APP_GUARD in
 * AppModule, so a new controller is protected by default — opting out requires
 * an explicit @Public().
 *
 * Roadmap item 2 replaces this with per-agent tokens issued at registration, or
 * mTLS on a private network. The single `expectedKey` read below is the only
 * place that has to change.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // WebSocket connections authenticate at handshake time in RealtimeGateway;
    // this guard only governs HTTP.
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers[API_KEY_HEADER];
    const expected = this.config.get<string>('agentApiKey');

    if (!expected) {
      // Config validation should have made this impossible; failing closed is
      // still the only safe response.
      this.logger.error('agentApiKey is not configured — refusing all requests.');
      throw new UnauthorizedException('Server auth is misconfigured');
    }

    if (!keyMatches(provided, expected)) {
      this.logger.warn(
        `Rejected ${request.method} ${request.originalUrl} from ${request.ip ?? 'unknown'}: ` +
          (provided ? 'bad key' : `missing ${API_KEY_HEADER} header`),
      );
      throw new UnauthorizedException(`Missing or invalid ${API_KEY_HEADER} header`);
    }

    return true;
  }
}
