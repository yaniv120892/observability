export type ObservabilityConfig = {
  logLevel: string;
  environment: string;
  betterStack: { sourceUrl: string; sourceToken: string } | null;
  sentryDsn: string | null;
  telegram: { botToken: string; chatId: string } | null;
};
