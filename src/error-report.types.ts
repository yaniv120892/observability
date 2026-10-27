export type ErrorReport = {
  error: unknown;
  /** Where the error was caught: the log message and the Sentry `where` tag. */
  where: string;
  context?: Record<string, unknown>;
};
