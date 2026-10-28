import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ProductAnalytics } from '../src/product-analytics.js';
import { createRecordingFetch, jsonBodyOf } from './fakes/recording-fetch.js';

const CONFIG = { projectKey: 'phc_test', host: 'https://eu.i.posthog.com' };

function createAnalytics({
  fetchImplementation,
  config = CONFIG,
}: {
  fetchImplementation: typeof fetch;
  config?: typeof CONFIG | null;
}) {
  const logger = pino({ level: 'silent' });
  const warn = vi.spyOn(logger, 'warn');
  const analytics = new ProductAnalytics({
    service: 'expenses',
    environment: 'production',
    config,
    logger,
    fetchImplementation,
  });
  return { analytics, warn };
}

describe('ProductAnalytics', () => {
  it('sends nothing without a project key', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const { analytics } = createAnalytics({ fetchImplementation, config: null });

    analytics.capture({ event: 'expense_created', userId: '42' });
    await analytics.flush();

    expect(analytics.isEnabled).toBe(false);
    expect(requests).toEqual([]);
  });

  it('batches queued events into one request and empties the queue', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const { analytics } = createAnalytics({ fetchImplementation });

    analytics.capture({ event: 'expense_created', userId: '42' });
    analytics.capture({ event: 'report_viewed', userId: '7' });
    await analytics.flush();
    await analytics.flush();

    expect(requests).toHaveLength(1);
    const body = jsonBodyOf(requests[0]);
    expect(body).toMatchObject({
      batch: [
        { event: 'expense_created', distinct_id: 'expenses:42' },
        { event: 'report_viewed', distinct_id: 'expenses:7' },
      ],
    });
  });

  it('keeps the newest events when the queue is full', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const { analytics } = createAnalytics({ fetchImplementation });

    for (let index = 0; index < 250; index += 1) {
      analytics.capture({ event: 'page_viewed', userId: String(index) });
    }
    await analytics.flush();

    const body = jsonBodyOf(requests[0]);
    expect(body).toMatchObject({ batch: expect.any(Array) });
    const batch = typeof body === 'object' && body !== null && 'batch' in body ? body.batch : [];
    expect(Array.isArray(batch) && batch.length).toBe(200);
    expect(Array.isArray(batch) && batch.at(-1)).toMatchObject({ distinct_id: 'expenses:249' });
  });

  it('never throws, and warns once per run of failed sends', async () => {
    const fetchImplementation = vi.fn(async () => {
      throw new Error('network down');
    });
    const { analytics, warn } = createAnalytics({ fetchImplementation });

    analytics.capture({ event: 'expense_created', userId: '42' });
    await expect(analytics.flush()).resolves.toBeUndefined();
    analytics.capture({ event: 'expense_created', userId: '42' });
    await analytics.flush();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns about a rejected batch with its status', async () => {
    const { fetchImplementation } = createRecordingFetch(401);
    const { analytics, warn } = createAnalytics({ fetchImplementation });

    analytics.capture({ event: 'expense_created', userId: '42' });
    await analytics.flush();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 401, droppedEvents: 1 }),
      'product_analytics_send_failed',
    );
  });

  it('waits for a send already under way, so a shutdown flush does not drop it', async () => {
    let releaseSend: () => void = () => undefined;
    const fetchImplementation = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseSend = () => resolve(new Response('', { status: 200 }));
        }),
    );
    const { analytics } = createAnalytics({ fetchImplementation });
    analytics.capture({ event: 'expense_created', userId: '42' });
    const timerFlush = analytics.flush();

    let isShutdownFlushDone = false;
    async function shutdownFlushing(): Promise<void> {
      await analytics.flush();
      isShutdownFlushDone = true;
    }
    const shutdownFlush = shutdownFlushing();
    await Promise.resolve();
    expect(isShutdownFlushDone).toBe(false);

    releaseSend();
    await Promise.all([timerFlush, shutdownFlush]);
    expect(isShutdownFlushDone).toBe(true);
  });

  it('resolves under steady traffic, leaving events captured during its send for the next flush', async () => {
    const capturing: { analytics?: ProductAnalytics } = {};
    const fetchImplementation = vi.fn(async () => {
      capturing.analytics?.capture({ event: 'page_viewed', userId: '42' });
      return new Response('', { status: 200 });
    });
    const { analytics } = createAnalytics({ fetchImplementation });
    capturing.analytics = analytics;
    analytics.capture({ event: 'page_viewed', userId: '42' });

    await analytics.flush();

    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('says how many events it dropped once the queue overflowed', async () => {
    const { fetchImplementation } = createRecordingFetch();
    const { analytics, warn } = createAnalytics({ fetchImplementation });

    for (let index = 0; index < 205; index += 1) {
      analytics.capture({ event: 'page_viewed', userId: String(index) });
    }
    await analytics.flush();

    expect(warn).toHaveBeenCalledWith({ droppedEvents: 5 }, 'product_analytics_queue_overflowed');
  });
});
