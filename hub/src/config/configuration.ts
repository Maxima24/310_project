import { validateEnv } from './env.validation';

/**
 * Typed shape injected everywhere via ConfigService. Grouping by concern keeps
 * call sites reading as `config.get('liveness.timeoutMs')` rather than shouting
 * env var names through the codebase.
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  auth: {
    /** Enrollment only. */
    bootstrapKey: string;
    /** Dashboards and humans. */
    operatorKey: string;
  };
  corsOrigin: string | string[];
  liveness: {
    timeoutMs: number;
    heartbeatIntervalMs: number;
    sweepCron: string;
  };
  alerts: {
    cooldownMs: number;
  };
  pagination: {
    defaultLimit: number;
    maxLimit: number;
  };
}

export function loadConfiguration(): AppConfig {
  const env = validateEnv(process.env as Record<string, unknown>);

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    auth: {
      bootstrapKey: env.AGENT_BOOTSTRAP_KEY,
      operatorKey: env.OPERATOR_KEY,
    },
    corsOrigin:
      env.CORS_ORIGIN === '*'
        ? '*'
        : env.CORS_ORIGIN.split(',')
            .map((o) => o.trim())
            .filter(Boolean),
    liveness: {
      timeoutMs: env.HEARTBEAT_TIMEOUT_MS,
      heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
      sweepCron: env.LIVENESS_SWEEP_CRON,
    },
    alerts: {
      cooldownMs: env.ALERT_COOLDOWN_MS,
    },
    pagination: {
      defaultLimit: env.EVENTS_PAGE_LIMIT,
      maxLimit: env.EVENTS_PAGE_MAX,
    },
  };
}
