import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecordingFetch, jsonBodyOf } from './fakes/recording-fetch.js';

// `next/server.js` is not mocked: its real `after` throws outside a request scope, as it does in
// `instrumentation.ts`'s `register`, where an app logs its boot warnings.
vi.mock('@sentry/nextjs', () => ({
  captureException: () => undefined,
  captureRequestError: () => undefined,
  getGlobalScope: () => ({ addEventProcessor: () => undefined }),
}));

const { createNextObservability } = await import('../src/next/observability.js');

/** Where Vercel's runtime puts the invocation's context, which `@vercel/functions` reads. */
const VERCEL_REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

type VercelRequestContext = {
  get: () => { waitUntil?: (promise: Promise<unknown>) => void };
};

let serviceIndex = 0;
let recording: ReturnType<typeof createRecordingFetch>;
let keptAlive: Promise<unknown>[];

function freshObservability() {
  serviceIndex += 1;
  return createNextObservability({ service: `boot-app-${serviceIndex}` });
}

const shippedMessages = () =>
  recording.requests
    .filter((request) => request.url === 'https://in.logs.example/source')
    .flatMap((request) => {
      const batch = jsonBodyOf(request);
      return Array.isArray(batch) ? batch.map((record: { msg?: unknown }) => record.msg) : [];
    });

beforeEach(() => {
  recording = createRecordingFetch();
  keptAlive = [];
  vi.stubGlobal('fetch', recording.fetchImplementation);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('BETTERSTACK_SOURCE_URL', 'https://in.logs.example/source');
  vi.stubEnv('BETTERSTACK_SOURCE_TOKEN', 'source-token');
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, VERCEL_REQUEST_CONTEXT);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function installVercelRequestContext(): void {
  const context: VercelRequestContext = {
    get: () => ({ waitUntil: (promise) => keptAlive.push(promise) }),
  };
  Reflect.set(globalThis, VERCEL_REQUEST_CONTEXT, context);
}

describe('createNextObservability outside a request scope', () => {
  it('keeps the invocation alive until a boot warning reaches Better Stack', async () => {
    installVercelRequestContext();
    const { logger } = freshObservability();

    logger.warn({ missing: ['NEXT_PUBLIC_SENTRY_DSN'] }, 'sentry_errors_not_configured');

    // Vercel freezes the function once the response is sent and every `waitUntil` promise has
    // settled; a send nobody handed to it is lost in the freeze.
    expect(keptAlive).toHaveLength(1);
    await Promise.all(keptAlive);
    expect(shippedMessages()).toEqual(['sentry_errors_not_configured']);
  });

  it('keeps each boot warning of a cold start alive, not only the first', async () => {
    installVercelRequestContext();
    const { logger } = freshObservability();

    logger.warn('sentry_errors_not_configured');
    logger.warn('telegram_alerts_not_configured');

    expect(keptAlive).toHaveLength(2);
    await Promise.all(keptAlive);
    expect(shippedMessages()).toEqual([
      'sentry_errors_not_configured',
      'telegram_alerts_not_configured',
    ]);
  });

  it('still sends a boot warning where there is no Vercel context, as in a local script', async () => {
    const { logger } = freshObservability();

    logger.warn('sentry_errors_not_configured');

    await vi.waitFor(() => expect(shippedMessages()).toEqual(['sentry_errors_not_configured']));
  });

  it('keeps nothing alive for a record it does not ship', () => {
    installVercelRequestContext();
    const { logger } = freshObservability();

    logger.info('server_started');

    expect(keptAlive).toEqual([]);
    expect(recording.requests).toEqual([]);
  });
});
