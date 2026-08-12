import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/** The sample key shipped in `.env.example`. Refused in production. */
export const SAMPLE_API_KEY = 'dev-key-change-me';

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

  @IsString()
  @IsNotEmpty({ message: 'AGENT_API_KEY is required — copy .env.example to .env and set one.' })
  AGENT_API_KEY: string;

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

  @IsInt()
  @Min(1)
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

  if (config.NODE_ENV === NodeEnv.Production && config.AGENT_API_KEY === SAMPLE_API_KEY) {
    throw new Error(
      `AGENT_API_KEY is still the sample value "${SAMPLE_API_KEY}". Set a real key before running in production.`,
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
