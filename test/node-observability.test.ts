import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeObservability } from '../src/node/observability.js';
import { createRecordingFetch, jsonBodyOf } from './fakes/recording-fetch.js';

const capturedExceptions: { error: unknown; hint: unknown }[] = [];
const sentryFlushes: number[] = [];

vi.mock('@sentry/node', () => {
  const integration = () => ({ name: 'stub' });
  return {
    initWithoutDefaultIntegrations: () => undefined,
    eventFiltersIntegration: integration,
    functionToStringIntegration: integration,
    linkedErrorsIntegration: integration,
    dedupeIntegration: integration,
    nodeContextIntegration: integration,
    flush: async (timeout: number) => {
      sentryFlushes.push(timeout);
      return true;
    },
    captureException: (error: unknown, hint: unknown) => {
      capturedExceptions.push({ error, hint });
    },
  };
});

beforeEach(() => {
  capturedExceptions.length = 0;
  sentryFlushes.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

function shippedRecords(requests: ReturnType<typeof createRecordingFetch>['requests']) {
  return requests.flatMap((request) => {
    const batch = jsonBodyOf(request);
    return Array.isArray(batch) ? batch : [];
  });
}

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

  it('flushes product events on the timer even without log shipping', async () => {
    vi.useFakeTimers();
    try {
      const { requests, fetchImplementation } = createRecordingFetch();
      const observability = await createNodeObservability({
        service: 'arbox',
        environment: { NODE_ENV: 'production', POSTHOG_PROJECT_KEY: 'phc_test' },
        fetchImplementation,
        flushIntervalMs: 1000,
      });

      observability.captureEvent({ event: 'class_booked', userId: 'owner' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(requests.map((request) => request.url)).toEqual(['https://eu.i.posthog.com/batch/']);
      await observability.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends no product events from a development run', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'arbox',
      environment: { POSTHOG_PROJECT_KEY: 'phc_test' },
      fetchImplementation,
    });

    observability.captureEvent({ event: 'class_booked', userId: 'owner' });
    await observability.shutdown();

    expect(observability.integrations.productAnalytics).toBe(false);
    expect(requests).toEqual([]);
  });
});

describe('createNodeObservability on a long-running process', () => {
  it('ships buffered records on its timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { requests, fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'worker',
      environment,
      fetchImplementation,
      flushIntervalMs: 1000,
    });
    observability.logger.info('sync_started');
    await vi.advanceTimersByTimeAsync(1000);
    expect(shippedRecords(requests)).toEqual([expect.objectContaining({ msg: 'sync_started' })]);
    await observability.shutdown();
  });
});

describe('createNodeObservability in serverless mode', () => {
  const serverlessEnvironment = { ...environment, SENTRY_DSN: 'https://key@sentry.example/1' };

  it('starts no timer, so records wait for flushRemoteLogs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { requests, fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'function',
      mode: 'serverless',
      environment,
      fetchImplementation,
    });
    observability.logger.warn('slow_upstream');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(requests).toHaveLength(0);
    await observability.flushRemoteLogs();
    expect(shippedRecords(requests)).toEqual([expect.objectContaining({ msg: 'slow_upstream' })]);
  });

  it('holds product events for flushRemoteLogs instead of a timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { requests, fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'function',
      mode: 'serverless',
      environment: { NODE_ENV: 'production', POSTHOG_PROJECT_KEY: 'phc_test' },
      fetchImplementation,
    });
    observability.captureEvent({ event: 'expense_created', userId: '42' });
    expect(vi.getTimerCount()).toBe(0);
    await observability.flushRemoteLogs();
    expect(requests.map((request) => request.url)).toEqual(['https://eu.i.posthog.com/batch/']);
  });

  it('can be flushed again and again, sending only what arrived since', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'function',
      mode: 'serverless',
      environment,
      fetchImplementation,
    });
    observability.logger.warn('first');
    await observability.flushRemoteLogs();
    await observability.flushRemoteLogs();
    observability.logger.warn('second');
    await observability.flushRemoteLogs();
    expect(requests.map((request) => jsonBodyOf(request))).toEqual([
      [expect.objectContaining({ msg: 'first' })],
      [expect.objectContaining({ msg: 'second' })],
    ]);
  });

  it('ships from warn up by default, and from the level it is given', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const byDefault = await createNodeObservability({
      service: 'function',
      mode: 'serverless',
      environment,
      fetchImplementation,
    });
    const fromInfo = await createNodeObservability({
      service: 'function-info',
      mode: 'serverless',
      shipLevel: 'info',
      environment,
      fetchImplementation,
    });
    byDefault.logger.info('dropped');
    byDefault.logger.info({ ship: true }, 'marked');
    fromInfo.logger.info('kept');
    await Promise.all([byDefault.flushRemoteLogs(), fromInfo.flushRemoteLogs()]);
    expect(shippedRecords(requests).map((record) => record.msg)).toEqual(['marked', 'kept']);
  });

  it("hands an error's immediate send to waitUntil, which settles once it lands", async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const keptAlive: Promise<unknown>[] = [];
    const observability = await createNodeObservability({
      service: 'function',
      mode: 'serverless',
      environment,
      fetchImplementation,
      waitUntil: (promise) => keptAlive.push(promise),
    });
    observability.logger.warn('buffered_only');
    expect(keptAlive).toHaveLength(0);
    observability.logger.error('payment_failed');
    expect(keptAlive).toHaveLength(1);
    await Promise.all(keptAlive);
    expect(shippedRecords(requests).map((record) => record.msg)).toEqual([
      'buffered_only',
      'payment_failed',
    ]);
  });

  it('keeps the function alive for the Sentry send of a reported error', async () => {
    const keptAlive: Promise<unknown>[] = [];
    const observability = await createNodeObservability({
      service: 'function',
      mode: 'serverless',
      environment: serverlessEnvironment,
      fetchImplementation: createRecordingFetch().fetchImplementation,
      waitUntil: (promise) => keptAlive.push(promise),
    });
    observability.reportError({ error: new Error('x'), where: 'job_failed' });
    expect(capturedExceptions).toHaveLength(1);
    expect(sentryFlushes).toEqual([2000]);
    expect(keptAlive).toHaveLength(2);
  });

  it('still ships when waitUntil throws outside a request', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'function',
      mode: 'serverless',
      environment,
      fetchImplementation,
      waitUntil: () => {
        throw new Error('no request context');
      },
    });
    observability.logger.error('startup_failed');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
  });
});

describe('createNodeObservability health checks', () => {
  it('answers liveness without touching a dependency', async () => {
    const observability = await createNodeObservability({ service: 'worker', environment: {} });
    expect(observability.checkLiveness()).toEqual({ httpStatus: 200, body: { status: 'ok' } });
  });

  it('answers 503 naming the failed probe, and logs it', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'worker',
      mode: 'serverless',
      environment,
      fetchImplementation,
    });
    const check = observability.createDeepHealthCheck({
      probes: {
        redis: async () => {
          throw new Error('ECONNREFUSED');
        },
        storage: async () => 'ok',
      },
    });
    expect(await check()).toEqual({
      httpStatus: 503,
      body: {
        status: 'unhealthy',
        checks: { redis: 'fail', storage: 'ok' },
        checkedAt: expect.any(String),
      },
    });
    await observability.flushRemoteLogs();
    expect(shippedRecords(requests)).toEqual([
      expect.objectContaining({ msg: 'health_check_failed', check: 'redis' }),
    ]);
  });
});

describe('createNodeObservability with an errorMessage', () => {
  const withheld = (error: Error) => `${error.name}; message withheld`;

  it('withholds the message from the log line, its stack and its cause', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'worker',
      environment,
      fetchImplementation,
      errorMessage: withheld,
    });
    const cause = new Error('Failing row contains (7, dana@example.com, 12 Herzl St)');
    observability.reportError({
      error: new Error('insert failed for dana@example.com', { cause }),
      where: 'insert_failed',
    });
    await observability.shutdown();
    const [record] = shippedRecords(requests);
    expect(JSON.stringify(record)).not.toContain('dana@example.com');
    expect(record).toMatchObject({
      err: {
        message: 'Error; message withheld: Error; message withheld',
        stack: expect.stringContaining('Error: Error; message withheld\n'),
      },
    });
  });

  it('withholds the message from an ops alert', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'worker',
      environment: { TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_ALERT_CHAT_ID: '42' },
      fetchImplementation,
      errorMessage: withheld,
    });
    await observability.notifyOpsAlert({
      alertType: 'insert',
      title: 'Insert keeps failing',
      error: new Error('dana@example.com'),
    });
    expect(jsonBodyOf(requests[0])).toMatchObject({
      text: expect.stringContaining('Error: Error; message withheld'),
    });
    expect(JSON.stringify(jsonBodyOf(requests[0]))).not.toContain('dana@example.com');
  });
});
