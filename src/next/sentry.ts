import * as Sentry from '@sentry/nextjs';
import { scrubRequestUrlsBefore } from '../sentry-breadcrumbs.js';
import type { NextSentryOptions } from './sentry.types.js';

const IDENTIFYING_KEY_PATTERNS = ['forwarded', '-ip', 'remote-', 'via', '-user'];

// An unset `dataCollection` sends cookies (the session JWT), identifying headers and every request
// body. Each category is pinned so a permissive default added later cannot switch on silently.
const NO_REQUEST_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: { deny: IDENTIFYING_KEY_PATTERNS },
  httpBodies: [],
  urlQueryParams: { deny: IDENTIFYING_KEY_PATTERNS },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  graphQL: { document: false, variables: false },
  queues: false,
  stackFrameVariables: false,
} satisfies Sentry.BrowserOptions['dataCollection'];

/**
 * Errors only, and inert without `NEXT_PUBLIC_SENTRY_DSN`. Call it from `instrumentation.ts`'s
 * `register` and from `instrumentation-client.ts`. Every value is read inline: Next inlines
 * `process.env.NEXT_PUBLIC_*` only where it appears literally, and its minifier can fold a
 * passed-in value into an unbound shorthand that throws in the browser bundle. Request breadcrumbs
 * keep only the origin of the URL, before the app's own `beforeBreadcrumb` runs.
 */
export function initSentry({ beforeBreadcrumb }: NextSentryOptions = {}): void {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) {
    return;
  }
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment:
      process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    // Traces and Session Replay bill against their own quotas; only errors are budgeted. A sampler,
    // not a zero rate: a rate yields to a sampled decision inherited from an incoming trace header,
    // which would send spans carrying every outgoing request's full URL.
    tracesSampler: () => 0,
    beforeBreadcrumb: scrubRequestUrlsBefore(beforeBreadcrumb),
    dataCollection: NO_REQUEST_DATA_COLLECTION,
  });
}

export type { NextSentryOptions } from './sentry.types.js';
