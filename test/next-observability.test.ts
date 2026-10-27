import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecordingFetch, jsonBodyOf } from './fakes/recording-fetch.js';

const afterTasks: (() => Promise<void>)[] = [];
const sentryCalls: string[] = [];

vi.mock('next/server.js', () => ({
  after: (task: () => Promise<void>) => {
    afterTasks.push(task);
  },
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: () => sentryCalls.push('captureException'),
  captureRequestError: () => sentryCalls.push('captureRequestError'),
}));

const { createNextObservability } = await import('../src/next/observability.js');

let serviceIndex = 0;
let recording: ReturnType<typeof createRecordingFetch>;

function freshObservability() {
  serviceIndex += 1;
  return createNextObservability({ service: `next-app-${serviceIndex}` });
}

async function runAfterTasks(): Promise<void> {
  const tasks = afterTasks.splice(0);
  await Promise.all(tasks.map((task) => task()));
}

const betterStackRequests = () =>
  recording.requests.filter((request) => request.url === 'https://in.logs.example/source');
const telegramRequests = () =>
  recording.requests.filter((request) => request.url.startsWith('https://api.telegram.org/'));

beforeEach(() => {
  afterTasks.length = 0;
  sentryCalls.length = 0;
  recording = createRecordingFetch();
  vi.stubGlobal('fetch', recording.fetchImplementation);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('BETTERSTACK_SOURCE_URL', 'https://in.logs.example/source');
  vi.stubEnv('BETTERSTACK_SOURCE_TOKEN', 'source-token');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'bot-token');
  vi.stubEnv('TELEGRAM_ALERT_CHAT_ID', '42');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('createNextObservability', () => {
  it('returns the same instance for a service', () => {
    expect(createNextObservability({ service: 'same' })).toBe(
      createNextObservability({ service: 'same' }),
    );
  });

  it('ships warnings from one after hook per request, not one per record', async () => {
    const { logger } = freshObservability();
    logger.warn('slow_query');
    logger.warn('slow_query');
    logger.info('not_shipped');
    expect(afterTasks).toHaveLength(1);
    await runAfterTasks();
    expect(betterStackRequests()).toHaveLength(1);
    expect(jsonBodyOf(betterStackRequests()[0])).toHaveLength(2);
  });

  it('ships an error at once and keeps the invocation alive until it lands', async () => {
    const { logger } = freshObservability();
    logger.error('payment_failed');
    await vi.waitFor(() => expect(betterStackRequests()).toHaveLength(1));
    expect(afterTasks).toHaveLength(1);
  });

  it('ships an error logged while another send is in flight', async () => {
    const { logger } = freshObservability();
    logger.error('first_failure');
    logger.error('second_failure');
    await runAfterTasks();
    const shipped = betterStackRequests().flatMap((request) => {
      const batch = jsonBodyOf(request);
      return Array.isArray(batch) ? batch : [];
    });
    expect(shipped.map((record) => record.msg)).toEqual(['first_failure', 'second_failure']);
  });

  it('schedules a fresh hook once the last one is stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { logger } = freshObservability();
    logger.warn('first');
    vi.setSystemTime(Date.now() + 61_000);
    logger.warn('second');
    vi.useRealTimers();
    expect(afterTasks).toHaveLength(2);
  });

  it('reports a swallowed error to Sentry and the log', async () => {
    const { reportError } = freshObservability();
    reportError({ error: new Error('cache down'), where: 'cache_read_failed' });
    await vi.waitFor(() => expect(sentryCalls).toEqual(['captureException']));
    await vi.waitFor(() => expect(betterStackRequests()).toHaveLength(1));
  });

  it('turns an unhandled request error into Sentry, a log and a 5xx alert', async () => {
    const { onRequestError } = freshObservability();
    await onRequestError(
      new Error('boom'),
      { path: '/api/items?page=2', method: 'GET', headers: {} },
      {
        routerKind: 'App Router',
        routePath: '/api/items',
        routeType: 'route',
        renderSource: undefined,
        revalidateReason: undefined,
      },
    );
    expect(sentryCalls).toEqual(['captureRequestError']);
    const alert = jsonBodyOf(telegramRequests()[0]);
    expect(alert).toMatchObject({ text: expect.stringContaining('5xx on GET /api/items\n') });
    const errorRecord = betterStackRequests()
      .flatMap((request) => {
        const batch = jsonBodyOf(request);
        return Array.isArray(batch) ? batch : [];
      })
      .find((record) => record.msg === 'unhandled_request_error');
    expect(errorRecord).toMatchObject({ path: '/api/items' });
    expect(betterStackRequests().length).toBeGreaterThanOrEqual(1);
  });
});

describe('deep health route', () => {
  it('answers 503 naming the probe that failed or hung', async () => {
    vi.useFakeTimers();
    const { createDeepHealthRoute } = freshObservability();
    const route = createDeepHealthRoute({
      probes: { db: () => new Promise(() => undefined), redis: async () => 'PONG' },
      probeTimeoutMs: 100,
    });
    const pending = route();
    await vi.advanceTimersByTimeAsync(100);
    const response = await pending;
    vi.useRealTimers();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'unhealthy',
      checks: { db: 'fail', redis: 'ok' },
    });
  });

  it('reuses the last outcome within the window', async () => {
    const { createDeepHealthRoute } = freshObservability();
    const probe = vi.fn(async () => 'ok');
    const route = createDeepHealthRoute({ probes: { db: probe } });
    expect((await route()).status).toBe(200);
    expect((await route()).status).toBe(200);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
