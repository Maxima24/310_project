import {
  AgentOrigin,
  AgentStatus,
  AgentType,
  BROWSER_CAMERA_ID_PREFIX,
  BROWSER_CAPTURE_MAX_FPS,
  BROWSER_CAPTURE_WIDTH,
  BROWSER_SESSION_TTL_MS,
  MAX_BROWSER_CAMERAS,
  type BrowserCameraSessionResponse,
} from '@cpe310/contracts';
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { PrismaService } from '../common/prisma/prisma.service';
import { mintAgentToken } from '../common/security/tokens';

/**
 * Issues publishing credentials so a browser can act as a camera.
 *
 * WHY THIS IS ITS OWN SERVICE, not a branch in AgentsService: enrolling a device is
 * something the bootstrap key does once per sensor, whereas this hands a browser tab the
 * ability to inject video. Keeping credential issuance for a fabricable source in a file
 * of its own is what makes it reviewable.
 *
 * WHAT THE DESIGN ACTUALLY BUYS. It does not stop an admin feeding arbitrary video into
 * the system — nothing short of signed hardware could, and claiming otherwise would be
 * worse than not trying. What it does guarantee is four things:
 *
 *   1. the id is chosen HERE, so a browser feed cannot be named to look like hardware;
 *   2. `origin` is a hub-set column, so the label cannot be spoofed by a client;
 *   3. the number of such feeds is capped;
 *   4. every mint and revoke is in the audit trail, attributed to the role that did it.
 *
 * The token also expires, which is the answer to a laptop left publishing in an empty
 * meeting room: the session ends unless a human renews it.
 */
@Injectable()
export class BrowserCameraService {
  private readonly logger = new Logger(BrowserCameraService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a browser camera and returns its token exactly once.
   *
   * The caller supplies only a location and an optional label. Everything that matters —
   * id, type, origin, capabilities, expiry — is decided here.
   */
  async create(location: string, label?: string): Promise<BrowserCameraSessionResponse> {
    const live = await this.prisma.agent.count({
      where: { origin: AgentOrigin.Browser, tokenHash: { not: null } },
    });

    if (live >= MAX_BROWSER_CAMERAS) {
      throw new ForbiddenException(
        `${MAX_BROWSER_CAMERAS} browser cameras already exist, which is the limit. ` +
          'Stop one before starting another — the cap bounds how much of the camera wall ' +
          'can come from a browser rather than a device.',
      );
    }

    const agentId = `${BROWSER_CAMERA_ID_PREFIX}${randomBytes(4).toString('hex')}`;
    const { token, hash } = mintAgentToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + BROWSER_SESSION_TTL_MS);

    await this.prisma.agent.create({
      data: {
        id: agentId,
        type: AgentType.Camera,
        // The label is a note about whose laptop this is; it is displayed, never trusted,
        // and it goes in the location rather than anywhere load-bearing.
        location: label ? `${location} (${label})` : location,
        status: AgentStatus.Online,
        version: 'browser',
        capabilities: ['camera', 'stream', 'browser'],
        origin: AgentOrigin.Browser,
        tokenHash: hash,
        tokenIssuedAt: now,
        tokenExpiresAt: expiresAt,
      },
    });

    this.logger.log(
      `Provisioned browser camera ${agentId} at ${location}; token expires ${expiresAt.toISOString()}`,
    );

    return {
      agentId,
      // The only time the plaintext exists outside the browser that asked for it.
      token,
      expiresAt: expiresAt.toISOString(),
      maxFps: BROWSER_CAPTURE_MAX_FPS,
      maxWidth: BROWSER_CAPTURE_WIDTH,
    };
  }

  /**
   * Browser cameras that can still publish.
   *
   * Revoking nulls the token but keeps the row, so its events and audit entries stay
   * readable. That is right for history and wrong for the camera wall: a session with no
   * credential can never send another frame, so leaving it on the wall means a tile that
   * is permanently "offline" and cannot be explained or removed — which is exactly what
   * an operator reads as a broken camera.
   */
  async activeIds(): Promise<Set<string>> {
    const rows = await this.prisma.agent.findMany({
      where: { origin: AgentOrigin.Browser, tokenHash: { not: null } },
      select: { id: true },
    });

    return new Set(rows.map((row) => row.id));
  }

  /**
   * Deletes browser cameras whose session ended a while ago.
   *
   * Row hygiene, and it bounds the damage from a revoke that never arrived — a closed tab
   * on a dead network, say. Only touches rows that already hold no token, so an active
   * session is never at risk, and only after a full session TTL has passed so nothing is
   * removed while an operator might still be looking at its history.
   *
   * Device agents are untouched: a sensor that has been silent for a month is evidence,
   * not litter.
   */
  async reapEndedSessions(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - BROWSER_SESSION_TTL_MS);

    const { count } = await this.prisma.agent.deleteMany({
      where: {
        origin: AgentOrigin.Browser,
        tokenHash: null,
        lastSeenAt: { lt: cutoff },
      },
    });

    if (count > 0) this.logger.log(`Reaped ${count} ended browser camera session(s)`);
    return count;
  }

  /**
   * Rotates the token, extending the session.
   *
   * A renew rather than an indefinite token: the operator has to still be there. It also
   * invalidates the previous token, so a session cannot be forked by copying one.
   */
  async renew(agentId: string): Promise<BrowserCameraSessionResponse> {
    const existing = await this.requireBrowserCamera(agentId);
    const { token, hash } = mintAgentToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + BROWSER_SESSION_TTL_MS);

    await this.prisma.agent.update({
      where: { id: existing.id },
      data: {
        tokenHash: hash,
        tokenIssuedAt: now,
        tokenExpiresAt: expiresAt,
        tokenRotations: { increment: 1 },
      },
    });

    return {
      agentId: existing.id,
      token,
      expiresAt: expiresAt.toISOString(),
      maxFps: BROWSER_CAPTURE_MAX_FPS,
      maxWidth: BROWSER_CAPTURE_WIDTH,
    };
  }

  /**
   * Ends a session immediately.
   *
   * Nulls the hash rather than deleting the row: the agent, its events, and its audit
   * entries stay readable, which is the point of having recorded them. The credential
   * stops resolving on the very next request because the lookup is by hash.
   */
  async revoke(agentId: string): Promise<void> {
    const existing = await this.requireBrowserCamera(agentId);

    await this.prisma.agent.update({
      where: { id: existing.id },
      data: { tokenHash: null, tokenExpiresAt: null },
    });

    this.logger.log(`Revoked browser camera ${existing.id}`);
  }

  /**
   * Refuses to touch anything that is not a browser camera.
   *
   * Without this, these endpoints would be a way to revoke a real sensor's credential —
   * a denial-of-service against the fleet dressed up as session management.
   */
  private async requireBrowserCamera(agentId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, origin: true },
    });

    if (!agent || agent.origin !== AgentOrigin.Browser) {
      throw new NotFoundException(`No browser camera ${agentId}`);
    }

    return agent;
  }
}
