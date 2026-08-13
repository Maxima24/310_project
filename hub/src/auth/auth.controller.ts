import { Permission, type IdentityResponse } from '@cpe310/contracts';
import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';

import type { AuthenticatedRequest } from '../common/guards/auth.guard';
import { RequirePermissions } from '../common/guards/permissions.decorator';
import { CredentialService } from '../common/security/credential.service';

/**
 * Tells a caller what it is and what it may do.
 *
 * The dashboard renders its UI from this rather than hardcoding a role table, which
 * means a policy change on the hub takes effect in the browser without a redeploy, and
 * a stale client cannot grant itself anything — the server is the only authority.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly credentials: CredentialService) {}

  /**
   * Requires only SystemModeRead, the most basic read, so every human role can call
   * it. An agent token deliberately cannot: agents have no UI to render.
   */
  @Get('me')
  @RequirePermissions(Permission.SystemModeRead)
  me(@Req() request: AuthenticatedRequest): IdentityResponse {
    if (!request.identity) {
      // Unreachable: the guard populates this before the handler runs.
      throw new UnauthorizedException();
    }
    return this.credentials.toResponse(request.identity);
  }
}
