import type { ObservabilityConfig } from './config.types.js';

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Every integration is off unless its variables are set, so an app with a bare env still runs. */
export function loadObservabilityConfig(
  environment: Record<string, string | undefined> = process.env,
): ObservabilityConfig {
  const sourceUrl = optional(environment.BETTERSTACK_SOURCE_URL);
  const sourceToken = optional(environment.BETTERSTACK_SOURCE_TOKEN);
  const botToken = optional(environment.TELEGRAM_BOT_TOKEN);
  const chatId = optional(environment.TELEGRAM_ALERT_CHAT_ID);
  return {
    logLevel: optional(environment.LOG_LEVEL) ?? 'info',
    environment:
      optional(environment.VERCEL_ENV) ?? optional(environment.NODE_ENV) ?? 'development',
    betterStack: sourceUrl && sourceToken ? { sourceUrl, sourceToken } : null,
    sentryDsn: optional(environment.SENTRY_DSN) ?? optional(environment.NEXT_PUBLIC_SENTRY_DSN),
    telegram: botToken && chatId ? { botToken, chatId } : null,
  };
}
