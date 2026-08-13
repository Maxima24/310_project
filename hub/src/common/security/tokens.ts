import { AGENT_TOKEN_PREFIX } from '@cpe310/contracts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Bytes of entropy in an agent token. 32 bytes is well past brute-force range. */
const TOKEN_BYTES = 32;

/**
 * Mints a new agent token.
 *
 * Returns the plaintext (handed to the agent exactly once) and the hash (the only
 * form the hub keeps). A database dump therefore yields no working credentials, and
 * a lost token can only be rotated, never recovered.
 */
export function mintAgentToken(): { token: string; hash: string } {
  const token = AGENT_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, hash: hashToken(token) };
}

/**
 * SHA-256, not bcrypt/argon2, deliberately: this is a 256-bit random secret, not a
 * human-chosen password. There is no dictionary to attack, so a slow KDF buys
 * nothing — and it would be run on every single request, including a fleet's
 * heartbeats. Password hashing would be required if the input were user-chosen.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function looksLikeAgentToken(credential: string): boolean {
  return credential.startsWith(AGENT_TOKEN_PREFIX);
}

/**
 * Constant-time comparison for the two configured shared secrets (bootstrap and
 * operator). Length is checked first because `timingSafeEqual` throws on mismatched
 * buffers; leaking the length of a key is not a meaningful disclosure.
 */
export function secretMatches(provided: string, expected: string): boolean {
  if (!expected || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
}

/** Extracts the credential from an `Authorization: Bearer <credential>` header. */
export function extractBearer(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** Renders a credential safe to log: enough to correlate, not enough to reuse. */
export function redact(credential: string): string {
  if (credential.length <= 8) return '***';
  return `${credential.slice(0, 6)}...${credential.slice(-2)}`;
}
