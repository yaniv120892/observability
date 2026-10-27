import type {
  ErrorReport,
  ErrorReportCaptureContext,
  SentryTagValue,
} from './error-report.types.js';

/**
 * Every context value goes to `extra`; the primitive ones are also tags, so an issue can be
 * searched and grouped by them. `where` is set last so a context key cannot overwrite it.
 */
export function toSentryCaptureContext({
  where,
  context = {},
}: Omit<ErrorReport, 'error'>): ErrorReportCaptureContext {
  const primitiveEntries = Object.entries(context).filter(
    (entry): entry is [string, SentryTagValue] => isTagValue(entry[1]),
  );
  return { tags: { ...Object.fromEntries(primitiveEntries), where }, extra: context };
}

function isTagValue(value: unknown): value is SentryTagValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
