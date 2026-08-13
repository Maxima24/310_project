import {
  Permission,
  type SystemModeChangeResponse,
  type SystemModeResponse,
} from '@cpe310/contracts';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';

import type { AuthenticatedRequest } from '../common/guards/auth.guard';
import { CanReadMode, RequirePermissions } from '../common/guards/permissions.decorator';
import { PolicyService } from '../common/security/policy.service';
import { SetModeDto } from './dto/set-mode.dto';
import { SystemService } from './system.service';

@Controller('system')
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly policy: PolicyService,
  ) {}

  @Get('mode')
  @CanReadMode()
  getMode(): Promise<SystemModeResponse> {
    return this.system.getMode();
  }

  /**
   * Arming and disarming is the most consequential action in the system.
   *
   * The guard only establishes that the caller may change the mode at all; whether
   * *this* transition is allowed *now* is attribute-based and lives in PolicyService.
   * The headline rule: disarming while a critical alert is unacknowledged requires an
   * admin, because "make the alarm stop" is otherwise indistinguishable from
   * "investigate the alarm", and the former is what an intruder at the panel would do.
   *
   * SystemArm covers both directions here, with the policy separating them — a caller
   * holding neither arm nor disarm is already rejected by the guard.
   */
  @Post('mode')
  @RequirePermissions(Permission.SystemArm)
  @HttpCode(HttpStatus.OK)
  async setMode(
    @Body() dto: SetModeDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<SystemModeChangeResponse> {
    const decision = await this.policy.canSetMode(request.identity!, dto.mode);
    if (!decision.allowed) {
      // The reason is written for a human and surfaced directly in the dashboard, so
      // an operator learns what to do instead of seeing a bare 403.
      throw new ForbiddenException({
        message: decision.reason,
        requiresRole: decision.requiresRole,
      });
    }
    return this.system.setMode(dto.mode);
  }
}
