export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export type ObservabilityConfig = {
  logLevel: LogLevel;
  environment: string;
  betterStack: { sourceUrl: string; sourceToken: string } | null;
  sentryDsn: string | null;
  telegram: { botToken: string; chatId: string } | null;
};
