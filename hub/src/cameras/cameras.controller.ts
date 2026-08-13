import {
  MJPEG_BOUNDARY,
  Permission,
  type CameraStatusView,
  type StreamTicketResponse,
} from '@cpe310/contracts';
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AgentsService } from '../agents/agents.service';
import type { AuthenticatedRequest } from '../common/guards/auth.guard';
import { RequirePermissions } from '../common/guards/permissions.decorator';
import { Public } from '../common/guards/public.decorator';
import { PolicyService } from '../common/security/policy.service';
import { FrameStoreService, MAX_FRAME_BYTES } from './frame-store.service';

/** How long a stream waits for a frame before sending a keep-alive comment. */
const FRAME_WAIT_MS = 5_000;

@Controller('cameras')
export class CamerasController {
  constructor(
    private readonly frames: FrameStoreService,
    private readonly agents: AgentsService,
    private readonly policy: PolicyService,
  ) {}

  /** Which cameras are live right now. Zone-filtered like every other read. */
  @Get()
  @RequirePermissions(Permission.CamerasView)
  async list(@Req() request: AuthenticatedRequest): Promise<CameraStatusView[]> {
    const agents = await this.agents.findAll(request.identity);
    return agents
      .filter((agent) => agent.type === 'camera')
      .map((agent) => ({
        agentId: agent.id,
        location: agent.location,
        ...this.frames.status(agent.id),
      }));
  }

  /**
   * A camera pushing its own frame.
   *
   * The guard enforces that the token belongs to `:id`, so one camera cannot inject
   * pictures attributed to another — the same self-scoping that stops a sensor forging
   * another's events, and it matters more here: a fake feed is how you convince an
   * operator a room is empty.
   */
  @Post(':id/frame')
  @RequirePermissions(Permission.CamerasPublish)
  ingest(@Param('id') id: string, @Req() request: Request): { ok: true } {
    const body = request.body;

    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new BadRequestException('Expected a JPEG body with Content-Type: image/jpeg');
    }
    if (body.length > MAX_FRAME_BYTES) {
      throw new BadRequestException(`Frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    // Cheap magic-number check. Without it the hub would happily relay whatever bytes
    // an agent sent, and the browser would render nothing with no explanation.
    if (body[0] !== 0xff || body[1] !== 0xd8) {
      throw new BadRequestException('Body is not a JPEG');
    }

    this.frames.put(id, body);
    return { ok: true };
  }

  /** Latest still. Useful on its own, and the fallback when a stream cannot be opened. */
  @Get(':id/snapshot')
  @RequirePermissions(Permission.CamerasView)
  async snapshot(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    await this.assertMayWatch(id, request);

    const frame = this.frames.get(id);
    if (!frame) throw new NotFoundException(`No recent frame from ${id}`);

    response.setHeader('Content-Type', 'image/jpeg');
    // A still from a live camera must never be cached; a stale frame that looks current
    // is worse than no picture.
    response.setHeader('Cache-Control', 'no-store');
    response.send(frame.data);
  }

  /**
   * Exchanges the caller's real credential for a short-lived, single-use ticket.
   *
   * Needed because the stream below is consumed by an `<img>`, which cannot carry an
   * Authorization header.
   */
  @Post(':id/ticket')
  @RequirePermissions(Permission.CamerasView)
  async ticket(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<StreamTicketResponse> {
    await this.assertMayWatch(id, request);

    const { ticket, expiresInMs } = this.frames.issueTicket(id);
    return { ticket, expiresInMs, streamUrl: `/cameras/${id}/stream?ticket=${ticket}` };
  }

  /**
   * MJPEG stream: one multipart response held open, a new part per frame.
   *
   * Marked @Public because an `<img>` cannot send headers — authorisation comes from
   * the ticket, which was itself minted only for a caller holding cameras:view and
   * passing the zone check. The route is not unauthenticated; it authenticates
   * differently.
   */
  @Get(':id/stream')
  @Public()
  async stream(
    @Param('id') id: string,
    @Query('ticket') ticket: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    if (!ticket || !this.frames.redeemTicket(ticket, id)) {
      throw new ForbiddenException('Missing, expired, or already-used stream ticket');
    }

    response.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
      'Cache-Control': 'no-store, no-transform',
      Connection: 'close',
      // Caddy and other proxies buffer by default, which would hold frames back until
      // the buffer filled and make a live view lag by seconds.
      'X-Accel-Buffering': 'no',
    });

    let open = true;
    const close = () => {
      open = false;
    };
    response.on('close', close);
    response.on('error', close);

    // Send whatever is already buffered, so the picture appears immediately rather
    // than after the camera's next frame interval.
    const first = this.frames.get(id);
    if (first) this.writePart(response, first.data);

    let lastSent = first?.receivedAt ?? 0;

    while (open) {
      const frame = await this.frames.next(id, FRAME_WAIT_MS);

      if (!open) break;

      if (!frame) {
        // Nothing arrived. A comment line keeps the connection alive without pretending
        // there is a picture, so a camera that pauses does not look like a dead socket.
        response.write(`\r\n--${MJPEG_BOUNDARY}\r\nContent-Type: text/plain\r\n\r\n\r\n`);
        continue;
      }

      if (frame.receivedAt === lastSent) continue;
      lastSent = frame.receivedAt;
      this.writePart(response, frame.data);
    }

    response.end();
  }

  private writePart(response: Response, data: Buffer): void {
    response.write(
      `\r\n--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${data.length}\r\n\r\n`,
    );
    response.write(data);
  }

  /** Camera must exist, be a camera, and sit inside the caller's zones. */
  private async assertMayWatch(id: string, request: AuthenticatedRequest): Promise<void> {
    const agent = await this.agents.findOne(id);
    if (!agent || agent.type !== 'camera') throw new NotFoundException(`No camera ${id}`);

    const decision = this.policy.canAccessLocation(request.identity!, agent.location);
    if (!decision.allowed) throw new ForbiddenException(decision.reason);
  }
}
