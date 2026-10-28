import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeObservability } from '../src/node/observability.js';
import { createRecordingFetch, jsonBodyOf } from './fakes/recording-fetch.js';

const capturedExceptions: { error: unknown; hint: unknown }[] = [];

vi.mock('@sentry/node', () => {
  const integration = () => ({ name: 'stub' });
  return {
    initWithoutDefaultIntegrations: () => undefined,
    eventFiltersIntegration: integration,
    functionToStringIntegration: integration,
    linkedErrorsIntegration: integration,
    dedupeIntegration: integration,
    nodeContextIntegration: integration,
    flush: async () => true,
    captureException: (error: unknown, hint: unknown) => {
      capturedExceptions.push({ error, hint });
    },
  };
});

beforeEach(() => {
  capturedExceptions.length = 0;
});

const environment = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  BETTERSTACK_SOURCE_URL: 'https://in.logs.example/source',
  BETTERSTACK_SOURCE_TOKEN: 'source-token',
};

describe('createNodeObservability', () => {
  it('ships info records on shutdown and errors at once', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'worker',
      environment,
      fetchImplementation,
      flushIntervalMs: 60_000,
    });
    observability.logger.info('sync_started');
    expect(requests).toHaveLength(0);
    observability.reportError({
      error: new Error('login failed'),
      where: 'sync_failed',
      context: { attempt: 2 },
    });
    await expect.poll(() => requests.length).toBe(1);
    expect(jsonBodyOf(requests[0])).toEqual([
      expect.objectContaining({ msg: 'sync_started', level: 'info', service: 'worker' }),
      expect.objectContaining({ msg: 'sync_failed', level: 'error', attempt: 2 }),
    ]);
    observability.logger.info('sync_finished');
    await observability.shutdown();
    expect(jsonBodyOf(requests[1])).toEqual([expect.objectContaining({ msg: 'sync_finished' })]);
  });

  it('reports which integrations are live', async () => {
    const { fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'worker',
      environment,
      fetchImplementation,
    });
    expect(observability.integrations).toEqual({
      betterStack: true,
      sentry: false,
      telegram: false,
      productAnalytics: false,
    });
    await observability.shutdown();
  });

  it('sends the report context to Sentry as extra, and its primitives as tags', async () => {
    const { fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'worker',
      environment: { SENTRY_DSN: 'https://key@sentry.example/1' },
      fetchImplementation,
    });
    const error = new Error('login failed');
    observability.reportError({
      error,
      where: 'sync_failed',
      context: { memberId: 'member-7', attempt: 2, session: { cookie: 'sid=x' }, token: 'x' },
    });
    await observability.shutdown();
    expect(observability.integrations.sentry).toBe(true);
    expect(capturedExceptions).toEqual([
      {
        error,
        hint: {
          tags: { memberId: 'member-7', attempt: 2, where: 'sync_failed' },
          extra: {
            memberId: 'member-7',
            attempt: 2,
            session: { cookie: '[redacted]' },
            token: '[redacted]',
          },
        },
      },
    ]);
  });

  it('runs with no integrations configured', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'worker',
      environment: {},
      fetchImplementation,
    });
    observability.reportError({ error: new Error('x'), where: 'anything' });
    await observability.notifyOpsAlert({ alertType: 'x', title: 'x' });
    await observability.pingHeartbeat('BETTERSTACK_HEARTBEAT_SYNC');
    await observability.shutdown();
    expect(requests).toHaveLength(0);
  });

  it('ships a burst of more than a buffer of info records without dropping any', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'worker',
      environment,
      fetchImplementation,
      flushIntervalMs: 60_000,
    });
    for (let index = 0; index < 250; index += 1) {
      observability.logger.info({ index }, 'step');
    }
    await observability.shutdown();
    const shipped = requests.flatMap((request) => {
      const batch = jsonBodyOf(request);
      return Array.isArray(batch) ? batch : [];
    });
    expect(shipped).toHaveLength(250);
  });

  it('pings the heartbeat named by an environment variable', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'worker',
      environment: { BETTERSTACK_HEARTBEAT_SYNC: 'https://uptime.example/hb' },
      fetchImplementation,
    });
    await observability.pingHeartbeat('BETTERSTACK_HEARTBEAT_SYNC');
    expect(requests.map((request) => request.url)).toEqual(['https://uptime.example/hb']);
  });

  it('ships product events on shutdown, as the app, under an app-scoped person', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'arbox',
      environment: { NODE_ENV: 'production', POSTHOG_PROJECT_KEY: 'phc_test' },
      fetchImplementation,
      flushIntervalMs: 60_000,
    });

    observability.captureEvent({ event: 'class_booked', userId: 'owner', properties: { day: 3 } });
    await observability.shutdown();

    expect(observability.integrations.productAnalytics).toBe(true);
    expect(requests.map((request) => request.url)).toEqual(['https://eu.i.posthog.com/batch/']);
    expect(jsonBodyOf(requests[0])).toEqual({
      api_key: 'phc_test',
      batch: [
        {
          event: 'class_booked',
          distinct_id: 'arbox:owner',
          timestamp: expect.any(String),
          properties: { day: 3, app: 'arbox', environment: 'production' },
        },
      ],
    });
  });
});
