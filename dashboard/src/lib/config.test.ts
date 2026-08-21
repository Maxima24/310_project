import { describe, expect, it } from 'vitest';

import { resolveApiBase } from './config';

describe('API base resolution', () => {
  it('treats an EMPTY string as unset', () => {
    // The bug this exists for. Docker Compose passes build args as strings, so an
    // "unset" value arrives as ''. With `??` that was accepted as a real value, the
    // bundle called /auth/me instead of /api/auth/me, Caddy served the SPA fallback for
    // it, and every request came back as a 200 of HTML that failed to parse as JSON —
    // presenting as "cannot log in" with no usable error anywhere.
    expect(resolveApiBase('')).toBe('/api');
  });

  it('treats undefined as unset', () => {
    expect(resolveApiBase(undefined)).toBe('/api');
  });

  it('keeps an explicit same-origin prefix', () => {
    // Not redundant with the default: both proxies match on /api and STRIP it, so the
    // prefix is how a request is routed, not merely where it is sent.
    expect(resolveApiBase('/api')).toBe('/api');
  });

  it('keeps an absolute origin for a split deployment', () => {
    expect(resolveApiBase('https://hub.example.com')).toBe('https://hub.example.com');
  });

  it('trims a trailing slash, so paths never double up', () => {
    expect(resolveApiBase('https://hub.example.com/')).toBe('https://hub.example.com');
    expect(resolveApiBase('/api/')).toBe('/api');
  });

  it('never resolves to an empty prefix, however it is written', () => {
    // The invariant, and the reason it is stated as a loop rather than a single case:
    // '' and '/' reach the broken state by different routes — one through the nullish
    // check, one through trimming — and only the second was caught by writing this.
    // An empty base means every call omits /api and silently hits the dashboard's own
    // routes instead of the hub.
    for (const input of ['', undefined, '/', '//', '   ']) {
      expect(resolveApiBase(input)).not.toBe('');
    }
  });
});
