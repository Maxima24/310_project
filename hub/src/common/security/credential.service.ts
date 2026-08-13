import { AuthRole } from '@cpe310/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../prisma/prisma.service';
import { hashToken, looksLikeAgentToken, secretMatches } from './tokens';

/** What a presented credential turned out to be. */
export interface Identity {
  role: AuthRole;
  /** Set only for AuthRole.Agent — the agent this token belongs to. */
  agentId?: string;
}

/**
 * Resolves a bearer credential to an identity.
 *
 * Shared by the HTTP guard, the WebSocket gateway, and the MQTT ingestion path, so
 * there is exactly one implementation of "who is this?" in the system.
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
   * Order matters: the two shared secrets are compared in constant time first and
   * only a token-shaped string reaches the database, so an attacker cannot use
   * response timing to probe for valid prefixes, nor make every bad guess cost a
   * query.
   */
  async resolve(credential: string): Promise<Identity | null> {
    if (!credential) return null;

    const operatorKey = this.config.get<string>('auth.operatorKey') ?? '';
    if (secretMatches(credential, operatorKey)) {
      return { role: AuthRole.Operator };
    }

    const bootstrapKey = this.config.get<string>('auth.bootstrapKey') ?? '';
    if (secretMatches(credential, bootstrapKey)) {
      return { role: AuthRole.Bootstrap };
    }

    if (!looksLikeAgentToken(credential)) return null;

    // Hash lookup, not a scan: the hash column is unique and indexed, so this is a
    // single index hit regardless of fleet size.
    const agent = await this.prisma.agent.findUnique({
      where: { tokenHash: hashToken(credential) },
      select: { id: true },
    });

    return agent ? { role: AuthRole.Agent, agentId: agent.id } : null;
  }
}
