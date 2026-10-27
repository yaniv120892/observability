import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { pingHeartbeat } from '../src/heartbeat.js';
import { createRecordingFetch } from './fakes/recording-fetch.js';

function capturingLogger() {
  const messages: string[] = [];
  const logger = pino({}, { write: (line: string) => messages.push(JSON.parse(line).msg) });
  return { logger, messages };
}

describe('pingHeartbeat', () => {
  it('warns when the heartbeat URL is unset', async () => {
    const { logger, messages } = capturingLogger();
    await pingHeartbeat({ name: 'BETTERSTACK_HEARTBEAT_SYNC', url: undefined, logger });
    expect(messages).toEqual(['heartbeat_not_configured']);
  });

  it('posts to the heartbeat URL', async () => {
    const { logger, messages } = capturingLogger();
    const { requests, fetchImplementation } = createRecordingFetch();
    await pingHeartbeat({
      name: 'sync',
      url: 'https://uptime.example/hb',
      logger,
      fetchImplementation,
    });
    expect(requests).toMatchObject([
      { url: 'https://uptime.example/hb', init: { method: 'POST' } },
    ]);
    expect(messages).toEqual([]);
  });

  it('warns and resolves when the ping is rejected or fails', async () => {
    const { logger, messages } = capturingLogger();
    await pingHeartbeat({
      name: 'sync',
      url: 'https://uptime.example/hb',
      logger,
      fetchImplementation: createRecordingFetch(404).fetchImplementation,
    });
    await pingHeartbeat({
      name: 'sync',
      url: 'https://uptime.example/hb',
      logger,
      fetchImplementation: async () => {
        throw new Error('dns');
      },
    });
    expect(messages).toEqual(['heartbeat_ping_rejected', 'heartbeat_ping_failed']);
  });
});
