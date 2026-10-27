import { describe, expect, it } from 'vitest';
import { createNodeObservability } from '../src/node/observability.js';
import { createRecordingFetch, jsonBodyOf } from './fakes/recording-fetch.js';

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
    observability.reportError(new Error('login failed'), { where: 'sync_failed', attempt: 2 });
    await expect.poll(() => requests.length).toBe(1);
    expect(jsonBodyOf(requests[0])).toEqual([
      expect.objectContaining({ msg: 'sync_started', level: 'info', service: 'worker' }),
      expect.objectContaining({ msg: 'sync_failed', level: 'error', attempt: 2 }),
    ]);
    observability.logger.info('sync_finished');
    await observability.shutdown();
    expect(jsonBodyOf(requests[1])).toEqual([expect.objectContaining({ msg: 'sync_finished' })]);
  });

  it('runs with no integrations configured', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const observability = await createNodeObservability({
      service: 'worker',
      environment: {},
      fetchImplementation,
    });
    observability.reportError(new Error('x'), { where: 'anything' });
    await observability.alertOwner({ alertType: 'x', title: 'x' });
    await observability.shutdown();
    expect(requests).toHaveLength(0);
  });
});
