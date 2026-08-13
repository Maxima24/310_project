import { AGENT_TOKEN_PREFIX } from '@cpe310/contracts';

import {
  extractBearer,
  hashToken,
  looksLikeAgentToken,
  mintAgentToken,
  redact,
  secretMatches,
} from './tokens';

describe('mintAgentToken', () => {
  it('returns a prefixed token and its hash', () => {
    const { token, hash } = mintAgentToken();

    expect(token.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(hash).toHaveLength(64); // sha256 hex
    expect(hash).toBe(hashToken(token));
  });

  it('never returns the same token twice', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => mintAgentToken().token));

    expect(tokens.size).toBe(200);
  });

  it('produces a token long enough to be unguessable', () => {
    // 32 random bytes, base64url encoded.
    const { token } = mintAgentToken();

    expect(token.length).toBeGreaterThanOrEqual(AGENT_TOKEN_PREFIX.length + 40);
  });

  it('does not leak the plaintext into the hash', () => {
    const { token, hash } = mintAgentToken();

    // The hub stores only the hash, so a database dump must not contain anything
    // that can be replayed as a credential.
    expect(hash).not.toContain(token.slice(AGENT_TOKEN_PREFIX.length, 12));
  });
});

describe('hashToken', () => {
  it('is deterministic', () => {
    expect(hashToken('ag_abc')).toBe(hashToken('ag_abc'));
  });

  it('differs for different inputs', () => {
    expect(hashToken('ag_abc')).not.toBe(hashToken('ag_abd'));
  });
});

describe('looksLikeAgentToken', () => {
  it('recognises an issued token', () => {
    expect(looksLikeAgentToken(mintAgentToken().token)).toBe(true);
  });

  it.each(['dev-operator-key', 'random', '', 'AG_upper'])('rejects %p', (value) => {
    // Only token-shaped strings reach the database, so a flood of bad guesses
    // cannot make every attempt cost a query.
    expect(looksLikeAgentToken(value)).toBe(false);
  });
});

describe('secretMatches', () => {
  it('accepts an exact match', () => {
    expect(secretMatches('a-real-secret', 'a-real-secret')).toBe(true);
  });

  it('rejects a near miss of the same length', () => {
    expect(secretMatches('a-real-secreT', 'a-real-secret')).toBe(false);
  });

  it('rejects a length mismatch without throwing', () => {
    // timingSafeEqual throws on unequal buffer lengths, so length is checked first.
    expect(secretMatches('short', 'a-much-longer-secret')).toBe(false);
  });

  it('never matches when no secret is configured', () => {
    expect(secretMatches('anything', '')).toBe(false);
    // Guards against a misconfigured hub accepting an empty credential.
    expect(secretMatches('', '')).toBe(false);
  });
});

describe('extractBearer', () => {
  it('pulls the credential out of a Bearer header', () => {
    expect(extractBearer('Bearer ag_token')).toBe('ag_token');
  });

  it('is case-insensitive on the scheme and tolerates extra whitespace', () => {
    expect(extractBearer('  bearer   ag_token  ')).toBe('ag_token');
  });

  it.each([undefined, null, 42, '', 'ag_token', 'Basic abc', 'Bearer'])(
    'returns null for %p',
    (header) => {
      expect(extractBearer(header)).toBeNull();
    },
  );
});

describe('redact', () => {
  it('keeps enough to correlate a log line but not enough to reuse', () => {
    const token = 'ag_supersecretvalue123';

    const shown = redact(token);

    expect(shown).toContain('ag_');
    expect(shown).not.toContain('supersecretvalue');
  });

  it('hides a short credential entirely', () => {
    expect(redact('abc')).toBe('***');
  });
});
