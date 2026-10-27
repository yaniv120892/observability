export type ErrorReport = {
  error: unknown;
  /** Where the error was caught: the log message and the Sentry `where` tag. */
  where: string;
  context?: Record<string, unknown>;
};

export type SentryTagValue = string | number | boolean;

/** The `captureException` hint an error report becomes, in both the Next and Node SDKs. */
export type ErrorReportCaptureContext = {
  tags: Record<string, SentryTagValue>;
  extra: Record<string, unknown>;
};

/** An error report's Sentry-bound fields, plus the field names to censor on top of the defaults. */
export type SentryCaptureInput = Omit<ErrorReport, 'error'> & { secretKeys?: string[] };
