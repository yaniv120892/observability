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
});
