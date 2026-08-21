import {
  AuditActor,
  MAX_OPERATOR_LABEL_LENGTH,
  OPERATOR_LABEL_HEADER,
  actorForRole,
  type AuditAction,
  type AuditEntryView,
  type AuditOutcome,
} from '@cpe310/contracts';
import { Injectable, Logger } from '@nestjs/common';
import type { AuditLog, Prisma } from '@prisma/client';

import type { AuthenticatedRequest } from '../common/guards/auth.guard';
import { PrismaService } from '../common/prisma/prisma.service';

/** Everything the hub knows about who is acting. */
export interface AuditActorFields {
  actor: AuditActor;
  actorAgentId?: string;
  actorLabel?: string;
  ip?: string;
}

export interface AuditEntry extends AuditActorFields {
  action: AuditAction;
  outcome: AuditOutcome;
  reason?: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
  /**
   * Collapses repeats of the same key within `dedupeWindowMs` into one row. For
   * actions a client can legitimately repeat in a burst — see CameraViewed.
   */
  dedupeKey?: string;
  dedupeWindowMs?: number;
}

/** Default collapse window for deduplicated actions. */
export const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60_000;

/** C0 controls and DEL. Checked by code point rather than a regex literal, so the
 *  source stays plain ASCII and cannot be mangled by an editor or a formatter. */
function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

/**
 * Strips a self-asserted label down to something safe to store and display.
 *
 * This value is entirely attacker-controlled: anyone holding the shared operator key
 * can send any name. Control characters go because a newline in an audit line lets a
 * caller forge what looks like a second entry, and the length is capped because past
 * a certain size it stopped being a name and became a payload.
 */
export function sanitizeLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;

  const cleaned = [...raw]
    .map((ch) => (isControl(ch) ? ' ' : ch))
    .join('')
    .trim();
  if (!cleaned) return undefined;

  return cleaned.slice(0, MAX_OPERATOR_LABEL_LENGTH);
}

/**
 * Writes the audit trail.
 *
 * Two rules shape everything here.
 *
 * IT NEVER BLOCKS THE ACTION. A failed insert is logged loudly and swallowed. On a
 * physical security panel the alternative is worse: refusing to let someone disarm the
 * building because an audit row would not write is a lock-in caused by bookkeeping, and
 * a gap in the trail — which is loud in the log — beats a door that will not open.
 *
 * IT RECORDS ATTEMPTS, NOT JUST SUCCESSES. What did not happen, and why, is usually the
 * more interesting half.
 *
 * Scope note: only actions by callers who already passed the guard are audited.
 * Authentication failures and role-level rejections stay in the application log, because
 * writing a row per rejected request hands any unauthenticated client an unbounded write
 * into this table — an audit trail an attacker can flood is one nobody can read.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  /** dedupeKey -> epoch ms of the last row written for it. */
  private readonly recent = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads what the hub can attest about the caller, plus what the caller claims.
   *
   * The role comes from the resolved credential and cannot be spoofed. The label is
   * whatever the client sent. Keeping both in one place is what stops a call site
   * accidentally treating the second as the first.
   */
  actorFromRequest(request: AuthenticatedRequest): AuditActorFields {
    const identity = request.identity;

    return {
      actor: identity ? actorForRole(identity.role) : AuditActor.System,
      ...(identity?.agentId ? { actorAgentId: identity.agentId } : {}),
      ...(sanitizeLabel(request.headers?.[OPERATOR_LABEL_HEADER])
        ? { actorLabel: sanitizeLabel(request.headers[OPERATOR_LABEL_HEADER]) }
        : {}),
      ...(request.ip ? { ip: request.ip } : {}),
    };
  }

  /** Never throws, never rejects. See the class comment. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      if (entry.dedupeKey && this.suppress(entry.dedupeKey, entry.dedupeWindowMs)) return;

      await this.prisma.auditLog.create({
        data: {
          action: entry.action,
          outcome: entry.outcome,
          actor: entry.actor,
          actorAgentId: entry.actorAgentId ?? null,
          actorLabel: entry.actorLabel ?? null,
          reason: entry.reason ?? null,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          detail: (entry.detail ?? {}) as Prisma.InputJsonValue,
          ip: entry.ip ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        `AUDIT GAP — failed to record ${entry.outcome} ${entry.action} by ${entry.actor}: ` +
          `${(error as Error).message}`,
      );
    }
  }

  /**
   * True when this key was recorded recently enough to skip.
   *
   * Live view is the case that needs it: Phase 1 gave the dashboard automatic
   * reconnection, so a flapping camera mints a fresh ticket on every retry. Auditing
   * each one turns "who watched the lobby" into thousands of rows saying the same
   * thing. Collapsing them records the viewing session, which is the fact anyone
   * actually wants.
   *
   * In-memory on purpose: a hub restart writing one extra row is the right failure,
   * and a shared store would be real infrastructure for a cosmetic gain.
   */
  private suppress(key: string, windowMs = DEFAULT_DEDUPE_WINDOW_MS): boolean {
    const now = Date.now();
    const last = this.recent.get(key);

    if (last !== undefined && now - last < windowMs) return true;

    this.recent.set(key, now);

    // Opportunistic sweep so a long-lived hub does not accumulate a key per camera per
    // viewer forever. Cheap because the map only ever holds active viewing sessions.
    if (this.recent.size > 512) {
      for (const [k, at] of this.recent) {
        if (now - at >= windowMs) this.recent.delete(k);
      }
    }

    return false;
  }

  async findMany(query: {
    limit?: number;
    action?: AuditAction;
    outcome?: AuditOutcome;
    actor?: AuditActor;
    since?: string;
  }): Promise<AuditEntryView[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...(query.action ? { action: query.action } : {}),
        ...(query.outcome ? { outcome: query.outcome } : {}),
        ...(query.actor ? { actor: query.actor } : {}),
        ...(query.since ? { at: { gte: new Date(query.since) } } : {}),
      },
      orderBy: { at: 'desc' },
      take: Math.min(query.limit ?? 100, 500),
    });

    return rows.map(toAuditEntryView);
  }
}

export function toAuditEntryView(row: AuditLog): AuditEntryView {
  return {
    id: row.id,
    at: row.at.toISOString(),
    action: row.action,
    outcome: row.outcome,
    actor: row.actor,
    ...(row.actorAgentId ? { actorAgentId: row.actorAgentId } : {}),
    ...(row.actorLabel ? { actorLabel: row.actorLabel } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.targetType ? { targetType: row.targetType } : {}),
    ...(row.targetId ? { targetId: row.targetId } : {}),
    detail: (row.detail ?? {}) as Record<string, unknown>,
    ...(row.ip ? { ip: row.ip } : {}),
  };
}
