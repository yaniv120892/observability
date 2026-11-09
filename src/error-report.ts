import { REDACTED, redactSecrets } from './redaction.js';
import type {
  ErrorReportCaptureContext,
  SentryCaptureInput,
  SentryTagValue,
} from './error-report.types.js';

// Sentry drops a tag past these lengths, or with a newline in its value, as a processing error.
const MAX_TAG_KEY_LENGTH = 32;
const MAX_TAG_VALUE_LENGTH = 200;

/**
 * Context keys whose string values name a kind of thing rather than a person or a record, so they
 * are safe to index and group by. Any other string stays in `extra`, which Sentry does not index.
 */
export const DEFAULT_SENTRY_TAG_KEYS: readonly string[] = Object.freeze([
  'method',
  'route',
  'routePath',
  'routeType',
  'status',
  'statusCode',
  'model',
  'toolName',
  'provider',
  'operation',
  'currency',
  'locale',
]);

/**
 * Every context value goes to `extra`, censored as the logger censors it. A number or a boolean is
 * also a tag, so an issue can be searched and grouped by it; a string is a tag only under an
 * allow-listed key, since a tag is indexed and an id or an address there outlives the event.
 * `where` is set last so a context key cannot overwrite it.
 */
export function toSentryCaptureContext({
  where,
  context = {},
  secretKeys,
  tagKeys = [],
}: SentryCaptureInput): ErrorReportCaptureContext {
  const extra = redactSecrets({ context, secretKeys });
  const allowedStringKeys = new Set([...DEFAULT_SENTRY_TAG_KEYS, ...tagKeys]);
  const tagEntries = Object.entries(extra).filter((entry): entry is [string, SentryTagValue] =>
    isTag({ entry, allowedStringKeys }),
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

function isTag({
  entry: [key, value],
  allowedStringKeys,
}: {
  entry: [string, unknown];
  allowedStringKeys: Set<string>;
}): boolean {
  if (key.length > MAX_TAG_KEY_LENGTH) {
    return false;
  }
  switch (typeof value) {
    case 'number':
    case 'boolean':
      return true;
    case 'string':
      return (
        allowedStringKeys.has(key) &&
        value !== REDACTED &&
        value.length <= MAX_TAG_VALUE_LENGTH &&
        !value.includes('\n')
      );
    default:
      return false;
  }
}
