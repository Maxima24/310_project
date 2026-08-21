import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
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

/** Mirrors AlertSeverity; declared here so the env class can validate against it. */
export enum SeverityLevel {
  Info = 'info',
  Warning = 'warning',
  Critical = 'critical',
}

/** Sample secrets shipped in `.env.example`. Refused in production. */
export const SAMPLE_BOOTSTRAP_KEY = 'dev-bootstrap-key-change-me';
export const SAMPLE_OPERATOR_KEY = 'dev-operator-key-change-me';

export const SAMPLE_VIEWER_KEY = 'dev-viewer-key-change-me';
export const SAMPLE_ADMIN_KEY = 'dev-admin-key-change-me';

export const SAMPLE_KEYS = new Set<string>([
  SAMPLE_BOOTSTRAP_KEY,
  SAMPLE_OPERATOR_KEY,
  SAMPLE_VIEWER_KEY,
  SAMPLE_ADMIN_KEY,
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

  /**
   * Read-only credential. Optional: leave unset and there is simply no viewer role.
   * Restrict what it can see with VIEWER_ZONES.
   */
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'VIEWER_KEY must be at least 8 characters when set.' })
  VIEWER_KEY?: string;

  /**
   * Comma-separated agent locations a viewer may see. Empty means everything.
   * The attribute-based half of the model: two callers with the same role can be
   * entitled to different data.
   *
   * One key with one zone list is proportionate here; per-user zones want a users
   * table, which is the documented next step.
   */
  @IsString()
  VIEWER_ZONES: string = '';

  /**
   * Admin credential: everything an operator can do, plus the notification audit and
   * the override for disarming while a critical alert is unacknowledged. Optional.
   */
  @IsOptional()
  @IsString()
  @MinLength(8, { message: 'ADMIN_KEY must be at least 8 characters when set.' })
  ADMIN_KEY?: string;

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

  // --- Notification fan-out (roadmap item 3) --------------------------------
  // Each channel is inert until configured, so an unset SMTP_HOST simply means no
  // email rather than a failed delivery per alert.

  @IsInt()
  @Min(1)
  @Max(20)
  NOTIFY_MAX_ATTEMPTS: number = 5;

  @IsString()
  @IsNotEmpty()
  NOTIFY_RETRY_CRON: string = '*/30 * * * * *';

  @IsOptional()
  @IsString()
  SMTP_HOST?: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  SMTP_PORT: number = 1025;

  @IsBoolean()
  SMTP_SECURE: boolean = false;

  @IsOptional()
  @IsString()
  SMTP_USER?: string;

  @IsOptional()
  @IsString()
  SMTP_PASS?: string;

  @IsString()
  ALERT_EMAIL_FROM: string = 'security-hub@localhost';

  /** Without a recipient the email channel stays inert. */
  @IsOptional()
  @IsString()
  ALERT_EMAIL_TO?: string;

  @IsOptional()
  @IsString()
  ALERT_WEBHOOK_URL?: string;

  @IsOptional()
  @IsString()
  ALERT_WEBHOOK_SECRET?: string;

  @IsInt()
  @Min(500)
  ALERT_WEBHOOK_TIMEOUT_MS: number = 5_000;

  /**
   * Per-channel severity floors. Waking someone at 3am for an `info` recovery notice
   * is how an alarm gets ignored, so email and webhook default to `warning` while the
   * log channel records everything.
   */
  @IsEnum(SeverityLevel)
  EMAIL_MIN_SEVERITY: SeverityLevel = SeverityLevel.Warning;

  @IsEnum(SeverityLevel)
  WEBHOOK_MIN_SEVERITY: SeverityLevel = SeverityLevel.Warning;

  @IsEnum(SeverityLevel)
  LOG_MIN_SEVERITY: SeverityLevel = SeverityLevel.Info;

  // --- Retention -----------------------------------------------------------
  //
  // Nothing in this system deleted anything until now, so Event, Alert, and
  // Notification grew without bound. Every window below defaults to 0, meaning KEEP
  // FOREVER: an upgrade must never silently begin deleting a year of evidence. This
  // matches how the notification channels behave — inert until deliberately configured.

  @IsString()
  @IsNotEmpty()
  RETENTION_SWEEP_CRON: string = '0 30 3 * * *';

  /** Highest-volume table by far. 0 = keep forever. */
  @IsInt()
  @Min(0)
  RETENTION_EVENT_DAYS: number = 0;

  /** Acknowledged alerts only — see RetentionService. 0 = keep forever. */
  @IsInt()
  @Min(0)
  RETENTION_ALERT_DAYS: number = 0;

  /** Terminal notifications only; pending ones are the retry worker's queue. */
  @IsInt()
  @Min(0)
  RETENTION_NOTIFICATION_DAYS: number = 0;

  /**
   * The audit trail. Deliberately the window you would set LONGEST: it is the smallest
   * table by far and the one whose value is entirely in how far back it goes. 365 is
   * the sensible first non-zero value.
   */
  @IsInt()
  @Min(0)
  RETENTION_AUDIT_DAYS: number = 0;

  /** Rows per delete. Small enough that each statement is short-lived. */
  @IsInt()
  @Min(100)
  @Max(10_000)
  RETENTION_BATCH_SIZE: number = 1_000;

  /**
   * Caps one cycle's work so a huge first prune drains over successive nights instead
   * of in one pass that competes with ingestion for hours.
   */
  @IsInt()
  @Min(1)
  RETENTION_MAX_BATCHES: number = 50;

  /** Yield between batches, so a prune is never why an event POST waits for a connection. */
  @IsInt()
  @Min(0)
  RETENTION_BATCH_PAUSE_MS: number = 100;

  // --- Scheduled arming -----------------------------------------------------

  /** How often boundaries are checked. 30s keeps worst-case lateness under a minute. */
  @IsString()
  @IsNotEmpty()
  SCHEDULE_TICK_CRON: string = '*/30 * * * * *';

  /**
   * How late a boundary may be and still fire, in minutes.
   *
   * Covers the hub-was-down case without acting on a boundary hours stale: disarming a
   * building at 13:00 because a 07:00 schedule was missed lowers protection at a time
   * nobody chose. Past this, the miss is recorded and the schedule left alone.
   */
  @IsInt()
  @Min(0)
  @Max(720)
  SCHEDULE_GRACE_MINUTES: number = 60;

  // --- MQTT ingestion (roadmap item 4) --------------------------------------
  // Unset means HTTP-only, which stays the default. Set to enable the second
  // transport alongside REST, e.g. mqtt://mosquitto:1883.
  @IsOptional()
  @IsString()
  MQTT_URL?: string;
}

/** Keys that arrive as strings from the environment but must be numbers. */
const NUMERIC_KEYS = [
  'PORT',
  'HEARTBEAT_TIMEOUT_MS',
  'HEARTBEAT_INTERVAL_MS',
  'ALERT_COOLDOWN_MS',
  'EVENTS_PAGE_LIMIT',
  'EVENTS_PAGE_MAX',
  'NOTIFY_MAX_ATTEMPTS',
  'SMTP_PORT',
  'ALERT_WEBHOOK_TIMEOUT_MS',
  'RETENTION_EVENT_DAYS',
  'RETENTION_ALERT_DAYS',
  'RETENTION_NOTIFICATION_DAYS',
  'RETENTION_AUDIT_DAYS',
  'RETENTION_BATCH_SIZE',
  'RETENTION_MAX_BATCHES',
  'RETENTION_BATCH_PAUSE_MS',
  'SCHEDULE_GRACE_MINUTES',
] as const;

/** Keys that arrive as strings but must be booleans. */
const BOOLEAN_KEYS = ['SMTP_SECURE'] as const;

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
  for (const key of BOOLEAN_KEYS) {
    if (cleaned[key] !== undefined) {
      cleaned[key] = ['true', '1', 'yes'].includes(String(cleaned[key]).toLowerCase());
    }
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
    for (const key of ['AGENT_BOOTSTRAP_KEY', 'OPERATOR_KEY', 'VIEWER_KEY', 'ADMIN_KEY'] as const) {
      const value = config[key];
      if (value && SAMPLE_KEYS.has(value)) {
        throw new Error(
          `${key} is still a sample value ("${value}"). Set a real secret before running in production.`,
        );
      }
    }
  }

  // Every configured credential must be distinct. A duplicate silently collapses two
  // roles into one — reusing the bootstrap key as the operator key would hand every
  // agent host the ability to disarm, and a viewer key equal to the admin key would
  // make the read-only role a full override.
  const configured = Object.entries({
    AGENT_BOOTSTRAP_KEY: config.AGENT_BOOTSTRAP_KEY,
    OPERATOR_KEY: config.OPERATOR_KEY,
    VIEWER_KEY: config.VIEWER_KEY,
    ADMIN_KEY: config.ADMIN_KEY,
  }).filter((entry): entry is [string, string] => Boolean(entry[1]));

  const seen = new Map<string, string>();
  for (const [name, secret] of configured) {
    const previous = seen.get(secret);
    if (previous) {
      throw new Error(
        `${name} and ${previous} are the same value — each credential must be distinct, ` +
          'or the roles collapse into one and the separation is meaningless.',
      );
    }
    seen.set(secret, name);
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

  // A notification is the record of whether anyone was actually told about an alert.
  // Pruning it while its alert survives leaves an alert nobody can answer that question
  // for, which is worse than having no audit at all — it looks complete and is not.
  // 0 means keep forever, so it is the longest window rather than the shortest.
  const forever = Number.POSITIVE_INFINITY;
  const alertWindow = config.RETENTION_ALERT_DAYS || forever;
  const notificationWindow = config.RETENTION_NOTIFICATION_DAYS || forever;

  if (notificationWindow < alertWindow) {
    throw new Error(
      `RETENTION_NOTIFICATION_DAYS (${config.RETENTION_NOTIFICATION_DAYS}) is shorter than ` +
        `RETENTION_ALERT_DAYS (${config.RETENTION_ALERT_DAYS}); delivery records would be deleted ` +
        'while the alerts they explain are still on file. Note 0 means keep forever.',
    );
  }

  return config;
}
