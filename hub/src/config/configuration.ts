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
  notifications: {
    maxAttempts: number;
    retryCron: string;
    email: {
      host?: string;
      port: number;
      secure: boolean;
      user?: string;
      pass?: string;
      from: string;
      to?: string;
      minSeverity: string;
    };
    webhook: {
      url?: string;
      secret?: string;
      timeoutMs: number;
      minSeverity: string;
    };
    log: {
      minSeverity: string;
    };
  };
  pagination: {
    defaultLimit: number;
    maxLimit: number;
  };
  mqtt: {
    /** Undefined means HTTP-only ingestion. */
    url?: string;
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
    notifications: {
      maxAttempts: env.NOTIFY_MAX_ATTEMPTS,
      retryCron: env.NOTIFY_RETRY_CRON,
      email: {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        from: env.ALERT_EMAIL_FROM,
        to: env.ALERT_EMAIL_TO,
        minSeverity: env.EMAIL_MIN_SEVERITY,
      },
      webhook: {
        url: env.ALERT_WEBHOOK_URL,
        secret: env.ALERT_WEBHOOK_SECRET,
        timeoutMs: env.ALERT_WEBHOOK_TIMEOUT_MS,
        minSeverity: env.WEBHOOK_MIN_SEVERITY,
      },
      log: {
        minSeverity: env.LOG_MIN_SEVERITY,
      },
    },
    pagination: {
      defaultLimit: env.EVENTS_PAGE_LIMIT,
      maxLimit: env.EVENTS_PAGE_MAX,
    },
    mqtt: {
      url: env.MQTT_URL,
    },
  };
}
