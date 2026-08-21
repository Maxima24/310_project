import {
  AuthRole,
  permissionsForRole,
  type IdentityResponse,
  type Permission,
} from '@cpe310/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import { hashToken, looksLikeAgentToken, secretMatches } from './tokens';

/** Who is calling, and what they are entitled to. */
export interface Identity {
  role: AuthRole;
  permissions: readonly Permission[];
  /**
   * Agent locations this credential may see. Empty means unrestricted. The
   * attribute-based half of the model — two callers with the same role can be
   * entitled to different data.
   */
  zones: string[];
  /** Set only for AuthRole.Agent — the agent this token belongs to. */
  agentId?: string;
}

/**
 * Resolves a bearer credential to an identity.
 *
 * Shared by the HTTP guard, the WebSocket gateway, and MQTT ingestion, so there is
 * exactly one implementation of "who is this?" in the system.
 */
@Injectable()
export class CredentialService {
  private readonly logger = new Logger(CredentialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Returns the identity, or null if the credential is unrecognised.
   *
   * The shared secrets are compared in constant time first, and only a token-shaped
   * string reaches the database — so response timing cannot be used to probe for valid
   * prefixes, and a flood of bad guesses cannot make every attempt cost a query.
   *
   * Most-privileged first is deliberate: with distinct secrets (enforced at boot) the
   * order cannot change the outcome, but it makes the precedence explicit rather than
   * incidental.
   */
  async resolve(credential: string): Promise<Identity | null> {
    if (!credential) return null;

    const adminKey = this.config.get<string>('auth.adminKey');
    if (adminKey && secretMatches(credential, adminKey)) {
      return this.human(AuthRole.Admin);
    }

    const operatorKey = this.config.get<string>('auth.operatorKey') ?? '';
    if (secretMatches(credential, operatorKey)) {
      return this.human(AuthRole.Operator);
    }

    const viewerKey = this.config.get<string>('auth.viewerKey');
    if (viewerKey && secretMatches(credential, viewerKey)) {
      // Only the viewer is zone-restricted; operators and admins see everything.
      return this.human(AuthRole.Viewer, this.config.get<string[]>('auth.viewerZones') ?? []);
    }

    const bootstrapKey = this.config.get<string>('auth.bootstrapKey') ?? '';
    if (secretMatches(credential, bootstrapKey)) {
      return this.human(AuthRole.Bootstrap);
    }

    if (!looksLikeAgentToken(credential)) return null;

    // Hash lookup, not a scan: the column is unique and indexed, so this is a single
    // index hit regardless of fleet size.
    const agent = await this.prisma.agent.findUnique({
      where: { tokenHash: hashToken(credential) },
      select: { id: true, tokenExpiresAt: true },
    });

    if (!agent) return null;

    // Null means never expires, which is what a dedicated sensor needs — it should keep
    // working unattended for months. Browser cameras get a short expiry instead, so a
    // publishing credential cannot outlive the person who created it.
    if (agent.tokenExpiresAt && agent.tokenExpiresAt.getTime() <= Date.now()) {
      this.logger.warn(`Rejected expired token for agent ${agent.id}`);
      return null;
    }

    return {
      role: AuthRole.Agent,
      permissions: permissionsForRole(AuthRole.Agent),
      zones: [],
      agentId: agent.id,
    };
  }

  private human(role: AuthRole, zones: string[] = []): Identity {
    return { role, permissions: permissionsForRole(role), zones };
  }

  /** Shape returned by `GET /auth/me`, so the dashboard never derives its own rights. */
  toResponse(identity: Identity): IdentityResponse {
    return {
      role: identity.role,
      permissions: [...identity.permissions],
      zones: identity.zones,
      ...(identity.agentId ? { agentId: identity.agentId } : {}),
    };
  }
}
