import { describe, expect, it, vi } from 'vitest';
import { RemoteLogBuffer } from '../src/remote-log-buffer.js';
import { createRecordingFetch, jsonBodyOf } from './fakes/recording-fetch.js';

function bufferWith(shipLevel: 'info' | 'warn' = 'warn') {
  const recording = createRecordingFetch();
  const buffer = new RemoteLogBuffer({
    sourceUrl: 'https://in.logs.example/source',
    sourceToken: 'source-token',
    shipLevel,
    service: 'my-app',
    fetchImplementation: recording.fetchImplementation,
  });
  return { buffer, ...recording };
}

const line = (record: Record<string, unknown>) => JSON.stringify({ time: 1, ...record });

describe('RemoteLogBuffer', () => {
  it('ships records at or above the ship level, by number or by label', () => {
    const { buffer } = bufferWith('warn');
    expect(buffer.write(line({ level: 30, msg: 'info' }))).toBe('skipped');
    expect(buffer.write(line({ level: 'info', msg: 'info' }))).toBe('skipped');
    expect(buffer.write(line({ level: 40, msg: 'warn' }))).toBe('buffered');
    expect(buffer.write(line({ level: 'warn', msg: 'warn' }))).toBe('buffered');
  });

  it('ships a below-level record marked ship: true', () => {
    const { buffer } = bufferWith('warn');
    expect(buffer.write(line({ level: 'info', ship: true, msg: 'cron_finished' }))).toBe(
      'buffered',
    );
  });

  it('never ships a record marked localOnly', () => {
    const { buffer } = bufferWith('info');
    expect(buffer.write(line({ level: 'error', localOnly: true, msg: 'setup_link' }))).toBe(
      'skipped',
    );
  });

  it('marks errors urgent', () => {
    const { buffer } = bufferWith();
    expect(buffer.write(line({ level: 'error', msg: 'boom' }))).toBe('urgent');
  });

  it('posts the batch with the source token and empties the buffer', async () => {
    const { buffer, requests } = bufferWith();
    buffer.write(line({ level: 'warn', msg: 'slow' }));
    await buffer.flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.init?.headers).toMatchObject({ Authorization: 'Bearer source-token' });
    expect(jsonBodyOf(requests[0])).toEqual([
      { time: 1, dt: '1970-01-01T00:00:00.001Z', level: 'warn', msg: 'slow' },
    ]);
    await buffer.flush();
    expect(requests).toHaveLength(1);
  });

  it('caps the buffer and reports how many records it dropped', async () => {
    const { buffer, requests } = bufferWith();
    for (let index = 0; index < 105; index += 1) {
      buffer.write(line({ level: 'warn', msg: `record ${index}` }));
    }
    await buffer.flush();
    const batch = jsonBodyOf(requests[0]);
    expect(batch).toHaveLength(101);
    expect(batch).toContainEqual(
      expect.objectContaining({
        msg: 'remote_log_records_dropped',
        level: 'warn',
        service: 'my-app',
        droppedRecords: 5,
      }),
    );
  });

  it('swallows a failed send', async () => {
    const buffer = new RemoteLogBuffer({
      sourceUrl: 'https://in.logs.example/source',
      sourceToken: 'source-token',
      shipLevel: 'warn',
      service: 'my-app',
      fetchImplementation: async () => {
        throw new Error('network down');
      },
    });
    buffer.write(line({ level: 'error', msg: 'boom' }));
    await expect(buffer.flush()).resolves.toBeUndefined();
  });

  it('marks a full buffer urgent so a burst ships instead of dropping', () => {
    const { buffer } = bufferWith('info');
    const outcomes = Array.from({ length: 100 }, (_, index) =>
      buffer.write(line({ level: 'info', msg: `record ${index}` })),
    );
    expect(outcomes.at(-2)).toBe('buffered');
    expect(outcomes.at(-1)).toBe('urgent');
  });

  it('makes every concurrent flush wait for the records written before it', async () => {
    let releaseFirstSend = (): void => undefined;
    const sentBatches: unknown[] = [];
    const buffer = new RemoteLogBuffer({
      sourceUrl: 'https://in.logs.example/source',
      sourceToken: 'source-token',
      shipLevel: 'warn',
      service: 'my-app',
      fetchImplementation: async (_input, init) => {
        sentBatches.push(JSON.parse(String(init?.body)));
        if (sentBatches.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstSend = resolve;
          });
        }
        return new Response('');
      },
    });
    buffer.write(line({ level: 'warn', msg: 'first' }));
    const timerFlush = buffer.flush();
    buffer.write(line({ level: 'error', msg: 'second' }));
    const urgentFlush = buffer.flush();
    const shutdownFlush = buffer.flush();
    releaseFirstSend();
    await shutdownFlush;
    expect(sentBatches).toHaveLength(2);
    await Promise.all([timerFlush, urgentFlush]);
  });

  it('reports a rejected batch once on stderr, not into the buffer', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const recording = createRecordingFetch(401);
    const buffer = new RemoteLogBuffer({
      sourceUrl: 'https://in.logs.example/source',
      sourceToken: 'revoked',
      shipLevel: 'warn',
      service: 'my-app',
      fetchImplementation: recording.fetchImplementation,
    });
    for (const message of ['one', 'two']) {
      buffer.write(line({ level: 'warn', msg: message }));
      await buffer.flush();
    }
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('remote_log_batch_rejected');
    stderr.mockRestore();
  });
});
