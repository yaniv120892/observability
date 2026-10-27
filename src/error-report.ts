import { REDACTED, redactSecrets } from './logger.js';
import type {
  ErrorReportCaptureContext,
  SentryCaptureInput,
  SentryTagValue,
} from './error-report.types.js';

// Sentry drops a tag past these lengths, or with a newline in its value, as a processing error.
const MAX_TAG_KEY_LENGTH = 32;
const MAX_TAG_VALUE_LENGTH = 200;

/**
 * Every context value goes to `extra`; the primitive ones Sentry accepts as tags are also tags, so
 * an issue can be searched and grouped by them. Secrets are censored as the logger censors them
 * and never become tags, and `where` is set last so a context key cannot overwrite it.
 */
export function toSentryCaptureContext({
  where,
  context = {},
  secretKeys,
}: SentryCaptureInput): ErrorReportCaptureContext {
  const extra = redactSecrets({ context, secretKeys });
  const tagEntries = Object.entries(extra).filter((entry): entry is [string, SentryTagValue] =>
    isTag(entry),
  );
  return { tags: { ...Object.fromEntries(tagEntries), where }, extra };
}

/** The error is already logged, so a failing capture must not fail the path that reports it. */
export function captureQuietly(capture: () => void): void {
  try {
    capture();
  } catch {
    return;
  }
}

function isTag([key, value]: [string, unknown]): boolean {
  if (key.length > MAX_TAG_KEY_LENGTH) {
    return false;
  }
  switch (typeof value) {
    case 'number':
    case 'boolean':
      return true;
    case 'string':
      return value !== REDACTED && value.length <= MAX_TAG_VALUE_LENGTH && !value.includes('\n');
    default:
      return false;
  }
}
