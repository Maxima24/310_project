import {
  NodeEnv,
  SAMPLE_BOOTSTRAP_KEY,
  SAMPLE_OPERATOR_KEY,
  validateEnv,
} from './env.validation';

const VALID = {
  AGENT_BOOTSTRAP_KEY: 'a-real-bootstrap-secret',
  OPERATOR_KEY: 'a-real-operator-secret',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/security',
};

describe('validateEnv', () => {
  it('accepts a minimal valid environment and fills defaults', () => {
    const env = validateEnv({ ...VALID });

    expect(env.PORT).toBe(3000);
    expect(env.HEARTBEAT_INTERVAL_MS).toBe(10_000);
    expect(env.HEARTBEAT_TIMEOUT_MS).toBe(30_000);
  });

  it('coerces numeric strings, since everything arrives from the environment as text', () => {
    const env = validateEnv({ ...VALID, PORT: '8080', ALERT_COOLDOWN_MS: '5000' });

    expect(env.PORT).toBe(8080);
    expect(env.ALERT_COOLDOWN_MS).toBe(5000);
  });

  it('treats a blank value as absent so `FOO=` falls back to the default', () => {
    const env = validateEnv({ ...VALID, PORT: '' });

    expect(env.PORT).toBe(3000);
  });

  // The whole point of validating at boot: a hub that starts without these is a hub
  // that 401s or 500s mysteriously later.
  it.each(['AGENT_BOOTSTRAP_KEY', 'OPERATOR_KEY', 'DATABASE_URL'])(
    'refuses to start without %s',
    (key) => {
      const env: Record<string, unknown> = { ...VALID };
      delete env[key];

      expect(() => validateEnv(env)).toThrow(new RegExp(key));
    },
  );

  it.each(['AGENT_BOOTSTRAP_KEY', 'OPERATOR_KEY'])('rejects a short %s', (key) => {
    expect(() => validateEnv({ ...VALID, [key]: 'x' })).toThrow(/at least 8/i);
  });

  it('allows the sample keys outside production', () => {
    expect(() =>
      validateEnv({
        ...VALID,
        AGENT_BOOTSTRAP_KEY: SAMPLE_BOOTSTRAP_KEY,
        OPERATOR_KEY: SAMPLE_OPERATOR_KEY,
      }),
    ).not.toThrow();
  });

  it.each([
    ['AGENT_BOOTSTRAP_KEY', SAMPLE_BOOTSTRAP_KEY],
    ['OPERATOR_KEY', SAMPLE_OPERATOR_KEY],
  ])('refuses the sample %s in production', (key, sample) => {
    // Guards the one mistake that would ship an open alert system.
    expect(() =>
      validateEnv({ ...VALID, [key]: sample, NODE_ENV: NodeEnv.Production }),
    ).toThrow(/sample value/i);
  });

  it('refuses the pre-roadmap-2 shared key in production', () => {
    // An old .env carried forward must not silently work.
    expect(() =>
      validateEnv({ ...VALID, OPERATOR_KEY: 'dev-key-change-me', NODE_ENV: NodeEnv.Production }),
    ).toThrow(/sample value/i);
  });

  it('refuses identical bootstrap and operator secrets', () => {
    // Reusing one secret collapses the roles back into a shared key and hands every
    // agent host operator privileges — the exact thing roadmap 2 removes.
    expect(() =>
      validateEnv({
        ...VALID,
        AGENT_BOOTSTRAP_KEY: 'same-secret-value',
        OPERATOR_KEY: 'same-secret-value',
      }),
    ).toThrow(/same value/i);
  });

  it('refuses a viewer key equal to the admin key', () => {
    // Otherwise the read-only role silently becomes a full override.
    expect(() =>
      validateEnv({ ...VALID, VIEWER_KEY: 'shared-secret-x', ADMIN_KEY: 'shared-secret-x' }),
    ).toThrow(/same value/i);
  });

  it('accepts a config with no viewer or admin role at all', () => {
    // Both are optional; leaving them unset simply means those roles do not exist.
    const env = validateEnv({ ...VALID });

    expect(env.VIEWER_KEY).toBeUndefined();
    expect(env.ADMIN_KEY).toBeUndefined();
  });

  it('parses viewer zones into a trimmed list', () => {
    const env = validateEnv({ ...VALID, VIEWER_ZONES: ' Hallway , Lobby ,, ' });

    expect(env.VIEWER_ZONES).toBe(' Hallway , Lobby ,, ');
  });

  it('rejects a viewer key that is too short to be safe', () => {
    expect(() => validateEnv({ ...VALID, VIEWER_KEY: 'short' })).toThrow(/at least 8/i);
  });

  it('refuses a heartbeat timeout that is not longer than the interval', () => {
    // Otherwise the sweep marks every healthy agent offline between its beats.
    expect(() =>
      validateEnv({ ...VALID, HEARTBEAT_INTERVAL_MS: '30000', HEARTBEAT_TIMEOUT_MS: '30000' }),
    ).toThrow(/must exceed/i);
  });

  it('accepts a timeout comfortably above the interval', () => {
    const env = validateEnv({
      ...VALID,
      HEARTBEAT_INTERVAL_MS: '5000',
      HEARTBEAT_TIMEOUT_MS: '25000',
    });

    expect(env.HEARTBEAT_TIMEOUT_MS).toBe(25_000);
  });

  it('refuses a default page limit larger than the maximum', () => {
    expect(() =>
      validateEnv({ ...VALID, EVENTS_PAGE_LIMIT: '500', EVENTS_PAGE_MAX: '200' }),
    ).toThrow(/cannot exceed/i);
  });

  it('caps EVENTS_PAGE_MAX so one request cannot try to serialise the whole table', () => {
    expect(() => validateEnv({ ...VALID, EVENTS_PAGE_MAX: '1000000' })).toThrow(/EVENTS_PAGE_MAX/);
  });

  it('rejects a port outside the valid range', () => {
    expect(() => validateEnv({ ...VALID, PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => validateEnv({ ...VALID, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('parses a comma-separated CORS origin list', () => {
    const env = validateEnv({ ...VALID, CORS_ORIGIN: 'http://a.test, http://b.test' });

    expect(env.CORS_ORIGIN).toBe('http://a.test, http://b.test');
  });
});
