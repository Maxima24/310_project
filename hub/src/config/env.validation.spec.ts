import { NodeEnv, SAMPLE_API_KEY, validateEnv } from './env.validation';

const VALID = {
  AGENT_API_KEY: 'a-real-secret-key',
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
  it.each(['AGENT_API_KEY', 'DATABASE_URL'])('refuses to start without %s', (key) => {
    const env: Record<string, unknown> = { ...VALID };
    delete env[key];

    expect(() => validateEnv(env)).toThrow(new RegExp(key));
  });

  it('rejects an API key short enough to guess', () => {
    expect(() => validateEnv({ ...VALID, AGENT_API_KEY: 'x' })).toThrow(/at least 8/i);
  });

  it('allows the sample key outside production', () => {
    expect(() => validateEnv({ ...VALID, AGENT_API_KEY: SAMPLE_API_KEY })).not.toThrow();
  });

  it('refuses the sample key in production', () => {
    // Guards the one mistake that would ship an open alert system.
    expect(() =>
      validateEnv({ ...VALID, AGENT_API_KEY: SAMPLE_API_KEY, NODE_ENV: NodeEnv.Production }),
    ).toThrow(/sample value/i);
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
