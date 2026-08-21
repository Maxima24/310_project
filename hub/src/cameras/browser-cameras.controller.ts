import {
  AuditAction,
  AuditOutcome,
  Permission,
  type BrowserCameraSessionResponse,
} from '@cpe310/contracts';
import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';

import { AuditService } from '../audit/audit.service';
import type { AuthenticatedRequest } from '../common/guards/auth.guard';
import { RequirePermissions } from '../common/guards/permissions.decorator';
import { BrowserCameraService } from './browser-camera.service';
import { CreateBrowserCameraDto } from './dto/create-browser-camera.dto';

/**
 * Provisioning for browser cameras.
 *
 * A separate controller from CamerasController on purpose: that file holds the streaming
 * loop and the frame ingest, and mixing credential issuance into it would bury the one
 * set of routes that hands out the ability to publish.
 *
 * All three routes are admin-only via `cameras:provision`.
 */
@Controller('cameras/browser-sessions')
export class BrowserCamerasController {
  constructor(
    private readonly browserCameras: BrowserCameraService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @RequirePermissions(Permission.CamerasProvision)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateBrowserCameraDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<BrowserCameraSessionResponse> {
    const session = await this.browserCameras.create(dto.location, dto.label);

    // Recorded because someone creating a video source that can show anything is exactly
    // the kind of act the trail exists for — and it is attributed to the role that did
    // it, with whatever name they claimed at sign-in.
    await this.audit.record({
      ...this.audit.actorFromRequest(request),
      action: AuditAction.BrowserCameraProvisioned,
      outcome: AuditOutcome.Allowed,
      targetType: 'camera',
      targetId: session.agentId,
      detail: { location: dto.location, label: dto.label ?? null, expiresAt: session.expiresAt },
    });

    return session;
  }

  /** Extends a session. Rotating the token also invalidates any copy of the old one. */
  @Post(':id/renew')
  @RequirePermissions(Permission.CamerasProvision)
  renew(@Param('id') id: string): Promise<BrowserCameraSessionResponse> {
    return this.browserCameras.renew(id);
  }

  @Delete(':id')
  @RequirePermissions(Permission.CamerasProvision)
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Param('id') id: string, @Req() request: AuthenticatedRequest): Promise<void> {
    await this.browserCameras.revoke(id);

    await this.audit.record({
      ...this.audit.actorFromRequest(request),
      action: AuditAction.BrowserCameraRevoked,
      outcome: AuditOutcome.Allowed,
      targetType: 'camera',
      targetId: id,
    });
  }
}
