import {
  AgentOrigin,
  AuditAction,
  AuditOutcome,
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
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AgentsService } from '../agents/agents.service';
import { AuditService } from '../audit/audit.service';
import { BrowserCameraService } from './browser-camera.service';
import type { AuthenticatedRequest } from '../common/guards/auth.guard';
import { RequirePermissions } from '../common/guards/permissions.decorator';
import { Public } from '../common/guards/public.decorator';
import { PolicyService } from '../common/security/policy.service';
import {
  FrameStoreService,
  MAX_FRAME_BYTES,
  MAX_VIEWERS_PER_CAMERA,
} from './frame-store.service';

/** How long the loop waits for a new frame before re-sending the last one. */
const FRAME_WAIT_MS = 5_000;

/**
 * How long a stream tolerates a camera producing NOTHING before closing.
 *
 * Longer than FRAME_TTL_MS so a brief stall re-sends the last frame rather than
 * dropping the viewer, but short enough that a stopped camera does not hold a socket
 * open indefinitely.
 */
const STREAM_IDLE_TIMEOUT_MS = 60_000;

@Controller('cameras')
export class CamerasController {
  private readonly logger = new Logger(CamerasController.name);

  constructor(
    private readonly frames: FrameStoreService,
    private readonly agents: AgentsService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly browserCameras: BrowserCameraService,
  ) {}

  /** Which cameras are live right now. Zone-filtered like every other read. */
  @Get()
  @RequirePermissions(Permission.CamerasView)
  async list(@Req() request: AuthenticatedRequest): Promise<CameraStatusView[]> {
    const [agents, activeBrowsers] = await Promise.all([
      this.agents.findAll(request.identity),
      this.browserCameras.activeIds(),
    ]);

    return agents
      .filter((agent) => agent.type === 'camera')
      // An ended browser session keeps its row so its history survives, but it holds no
      // credential and can never publish again. Leaving it here would put a permanently
      // dead tile on the wall that nobody can account for or remove.
      .filter((agent) => agent.origin !== AgentOrigin.Browser || activeBrowsers.has(agent.id))
      .map((agent) => ({
        agentId: agent.id,
        location: agent.location,
        // Carried through so the dashboard can mark a browser feed everywhere it appears.
        // A client that had to infer this from `capabilities` would be trusting the agent
        // about itself, which for this particular fact is exactly backwards.
        origin: agent.origin,
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

    // A live view is surveillance of the surveillance, and worth a record of its own.
    //
    // Deduplicated because Phase 1 made the dashboard reconnect on its own: a flapping
    // camera mints a fresh ticket per retry, and one row each would bury "who watched
    // the lobby" under thousands of identical lines. Collapsing them records the
    // viewing SESSION, which is the fact anyone actually goes looking for.
    const actor = this.audit.actorFromRequest(request);
    await this.audit.record({
      ...actor,
      action: AuditAction.CameraViewed,
      outcome: AuditOutcome.Allowed,
      targetType: 'camera',
      targetId: id,
      dedupeKey: `camera:${id}:${actor.actor}:${actor.actorLabel ?? ''}:${actor.ip ?? ''}`,
    });

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

    // Each viewer holds this response open for as long as they watch, so capacity is
    // finite and has to be claimed rather than assumed.
    if (!this.frames.claimViewer(id)) {
      throw new HttpException(
        `Camera ${id} already has the maximum ${MAX_VIEWERS_PER_CAMERA} viewers`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
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
    // Aborting wakes the pending frame wait immediately, so a disconnecting viewer
    // gives its slot back at once rather than up to FRAME_WAIT_MS later.
    const disconnected = new AbortController();
    const close = () => {
      open = false;
      disconnected.abort();
    };
    response.on('close', close);
    response.on('error', close);

    try {
      // Send whatever is already buffered, so the picture appears immediately rather
      // than after the camera's next frame interval.
      const first = this.frames.get(id);
      if (first) this.writePart(response, first.data);

      // Sequence, not timestamp: two frames arriving in the same millisecond are
      // distinct, and comparing receivedAt silently dropped one of them.
      let lastSeq = first?.seq ?? 0;
      let silentSince = Date.now();

      while (open) {
        const frame = await this.frames.next(id, FRAME_WAIT_MS, disconnected.signal);
        if (!open) break;

        if (frame && frame.seq !== lastSeq) {
          lastSeq = frame.seq;
          silentSince = Date.now();
          this.writePart(response, frame.data);
          continue;
        }

        // Nothing new arrived.
        //
        // This branch previously wrote a `Content-Type: text/plain` part, which is a
        // defect: an <img> consuming multipart/x-mixed-replace tries to decode every
        // part as an image, fails on text, and fires onerror — so a camera that merely
        // paused for five seconds killed the view permanently. Re-sending the last
        // frame is what IP cameras do: it is a valid image part, it keeps proxies from
        // timing the connection out, and the picture stays truthful because a frame
        // older than FRAME_TTL_MS is not returned at all.
        const last = this.frames.get(id);
        if (last) {
          this.writePart(response, last.data);
          continue;
        }

        // Genuinely silent. Ending cleanly lets the client tell "this camera stopped"
        // apart from "the network broke", which decides whether reconnecting can help.
        if (Date.now() - silentSince > STREAM_IDLE_TIMEOUT_MS) {
          this.logger.log(`Closing idle stream for ${id} — no frames for ${STREAM_IDLE_TIMEOUT_MS}ms`);
          break;
        }
      }
    } finally {
      // Must run even if the socket errors, or the camera leaks a viewer slot and
      // eventually refuses everyone.
      this.frames.releaseViewer(id);
      response.end();
    }
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
