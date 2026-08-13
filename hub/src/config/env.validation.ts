import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/** Sample secrets shipped in `.env.example`. Refused in production. */
export const SAMPLE_BOOTSTRAP_KEY = 'dev-bootstrap-key-change-me';
export const SAMPLE_OPERATOR_KEY = 'dev-operator-key-change-me';

export const SAMPLE_KEYS = new Set<string>([
  SAMPLE_BOOTSTRAP_KEY,
  SAMPLE_OPERATOR_KEY,
  // The pre-roadmap-2 shared key, refused outright so an old .env cannot be carried
  // forward into production.
  'dev-key-change-me',
]);

/**
 * Boot-time env contract. A missing or nonsensical value must kill the process
 * here rather than surface later as a mystery 401 or a hub that silently never
 * detects an offline agent.
 */
export class EnvVars {
  @IsOptional()
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  /**
   * Provisioning secret. Authorises `POST /agents/register` and nothing else.
   * Every agent host needs it; compromise allows enrolling or re-enrolling agents,
   * which is why re-enrollments are counted and logged. mTLS or short-lived
   * enrollment tokens are the next step up (see README).
   */
  @IsString()
  @IsNotEmpty({
    message: 'AGENT_BOOTSTRAP_KEY is required — copy .env.example to .env and set one.',
  })
  @MinLength(8, { message: 'AGENT_BOOTSTRAP_KEY must be at least 8 characters.' })
  AGENT_BOOTSTRAP_KEY: string;

  /**
   * Operator credential: arm/disarm, acknowledge alerts, read history, WebSocket.
   * Must never be handed to a sensor — that would undo the separation entirely.
   */
  @IsString()
  @IsNotEmpty({ message: 'OPERATOR_KEY is required — copy .env.example to .env and set one.' })
  @MinLength(8, { message: 'OPERATOR_KEY must be at least 8 characters.' })
  OPERATOR_KEY: string;

  @IsString()
  @IsNotEmpty({ message: 'DATABASE_URL is required (postgresql://user:pass@host:5432/db).' })
  DATABASE_URL: string;

  /**
   * Silence tolerated before an agent is considered offline. Must exceed the
   * agent's heartbeat interval by enough to absorb a couple of dropped beats.
   */
  @IsInt()
  @Min(5_000)
  HEARTBEAT_TIMEOUT_MS: number = 30_000;

  /** Advertised to agents so they pace themselves to whatever the hub expects. */
  @IsInt()
  @Min(1_000)
  HEARTBEAT_INTERVAL_MS: number = 10_000;

  /** 6-field cron (seconds granularity) for the liveness sweep. */
  @IsString()
  @IsNotEmpty()
  LIVENESS_SWEEP_CRON: string = '*/5 * * * * *';

  /** Per-(type, agent) window in which a duplicate alert is suppressed. */
  @IsInt()
  @Min(0)
  ALERT_COOLDOWN_MS: number = 60_000;

  @IsInt()
  @Min(1)
  EVENTS_PAGE_LIMIT: number = 50;

  // Upper-bounded as well as lower: this is the ceiling a client's `?limit=` is
  // clamped to, so an absurd value here would let one request try to serialise the
  // entire events table into memory.
  @IsInt()
  @Min(1)
  @Max(1_000)
  EVENTS_PAGE_MAX: number = 200;

  /** Comma-separated WebSocket CORS origins, or `*`. */
  @IsString()
  CORS_ORIGIN: string = '*';
}

/** Keys that arrive as strings from the environment but must be numbers. */
const NUMERIC_KEYS = [
  'PORT',
  'HEARTBEAT_TIMEOUT_MS',
  'HEARTBEAT_INTERVAL_MS',
  'ALERT_COOLDOWN_MS',
  'EVENTS_PAGE_LIMIT',
  'EVENTS_PAGE_MAX',
] as const;

export function validateEnv(raw: Record<string, unknown>): EnvVars {
  // Drop blank values so `FOO=` in a .env file falls back to the class default
  // instead of failing validation as an empty string.
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== '' && value !== undefined) cleaned[key] = value;
  }
  for (const key of NUMERIC_KEYS) {
    if (cleaned[key] !== undefined) cleaned[key] = Number(cleaned[key]);
  }

  const config = plainToInstance(EnvVars, cleaned, { exposeDefaultValues: true });
  const errors = validateSync(config, { skipMissingProperties: false, whitelist: false });

  if (errors.length > 0) {
    const details = errors
      .map((e) => `  - ${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  if (config.NODE_ENV === NodeEnv.Production) {
    for (const key of ['AGENT_BOOTSTRAP_KEY', 'OPERATOR_KEY'] as const) {
      if (SAMPLE_KEYS.has(config[key])) {
        throw new Error(
          `${key} is still a sample value ("${config[key]}"). Set a real secret before running in production.`,
        );
      }
    }
  }

  if (config.AGENT_BOOTSTRAP_KEY === config.OPERATOR_KEY) {
    // Identical secrets collapse the two roles back into one shared key and undo
    // the entire point of separating them: any agent host could then arm/disarm.
    throw new Error(
      'AGENT_BOOTSTRAP_KEY and OPERATOR_KEY must differ — reusing one secret for both ' +
        'gives every agent host operator privileges.',
    );
  }

  if (config.HEARTBEAT_TIMEOUT_MS <= config.HEARTBEAT_INTERVAL_MS) {
    throw new Error(
      `HEARTBEAT_TIMEOUT_MS (${config.HEARTBEAT_TIMEOUT_MS}) must exceed HEARTBEAT_INTERVAL_MS ` +
        `(${config.HEARTBEAT_INTERVAL_MS}); otherwise every healthy agent is swept offline between beats.`,
    );
  }

  if (config.EVENTS_PAGE_LIMIT > config.EVENTS_PAGE_MAX) {
    throw new Error(
      `EVENTS_PAGE_LIMIT (${config.EVENTS_PAGE_LIMIT}) cannot exceed EVENTS_PAGE_MAX (${config.EVENTS_PAGE_MAX}).`,
    );
  }

  return config;
}
