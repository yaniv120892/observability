import type { LogLevel, ObservabilityConfig } from './config.types.js';

export const DEVELOPMENT_ENVIRONMENT = 'development';
const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com';
const LOG_LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** A typo'd level must stop the process at start-up, not fall back to a level nobody chose. */
function parseLogLevel(value: string | null): LogLevel {
  if (value === null) {
    return 'info';
  }
  const level = LOG_LEVELS.find((candidate) => candidate === value);
  if (!level) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')} (got "${value}")`);
  }
  return level;
}

/** Every integration is off unless its variables are set, so an app with a bare env still runs. */
export function loadObservabilityConfig(
  environment: Record<string, string | undefined> = process.env,
): ObservabilityConfig {
  const sourceUrl = optional(environment.BETTERSTACK_SOURCE_URL);
  const sourceToken = optional(environment.BETTERSTACK_SOURCE_TOKEN);
  const botToken = optional(environment.TELEGRAM_BOT_TOKEN);
  const chatId = optional(environment.TELEGRAM_ALERT_CHAT_ID);
  const projectKey = optional(environment.POSTHOG_PROJECT_KEY);
  return {
    logLevel: parseLogLevel(optional(environment.LOG_LEVEL)),
    environment:
      optional(environment.VERCEL_ENV) ?? optional(environment.NODE_ENV) ?? DEVELOPMENT_ENVIRONMENT,
    betterStack: sourceUrl && sourceToken ? { sourceUrl, sourceToken } : null,
    sentryDsn: optional(environment.SENTRY_DSN) ?? optional(environment.NEXT_PUBLIC_SENTRY_DSN),
    telegram: botToken && chatId ? { botToken, chatId } : null,
    productAnalytics: projectKey
      ? { projectKey, host: optional(environment.POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST }
      : null,
  };
}
