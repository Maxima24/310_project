import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time API key comparison.
 *
 * Extracted rather than living inside ApiKeyGuard because socket.io handshakes
 * bypass Nest guards entirely — RealtimeGateway has to perform the same check
 * itself, and two copies of an auth comparison is how one of them drifts.
 *
 * The length check is not just an optimisation: `timingSafeEqual` throws on
 * buffers of unequal length. Length is not a secret, so leaking it is fine.
 */
export function keyMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}
