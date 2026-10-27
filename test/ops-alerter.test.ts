import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { ALERTS_PER_HOUR, createInMemoryAlertCounter, OpsAlerter } from '../src/ops-alerter.js';
import { createRecordingFetch, jsonBodyOf } from './fakes/recording-fetch.js';

const telegram = { botToken: 'bot-token', chatId: '42' };
const silentLogger = pino({ level: 'silent' });

function textOf(request: Parameters<typeof jsonBodyOf>[0]): string {
  const body = jsonBodyOf(request);
  if (typeof body !== 'object' || body === null || !('text' in body)) {
    throw new Error('Telegram request had no text');
  }
  return String(body.text);
}

describe('OpsAlerter', () => {
  it('is inert without Telegram credentials', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const alerter = new OpsAlerter({
      service: 'my-app',
      telegram: null,
      logger: silentLogger,
      fetchImplementation,
    });
    await alerter.alert({ alertType: 'db', title: 'Database down' });
    expect(requests).toHaveLength(0);
  });

  it('sends plain text naming the service, the error and the context', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const alerter = new OpsAlerter({
      service: 'my-app',
      telegram,
      logger: silentLogger,
      fetchImplementation,
    });
    await alerter.alert({
      alertType: 'db',
      title: 'Database down',
      error: new Error('connect_timeout'),
      context: { route: '/api/items', skipped: undefined },
    });
    expect(requests[0]?.url).toBe('https://api.telegram.org/botbot-token/sendMessage');
    expect(textOf(requests[0])).toBe(
      '🚨 [my-app] Database down\nError: connect_timeout\nroute: /api/items',
    );
  });

  it('sends the cap, then one suppression notice, then nothing', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const alerter = new OpsAlerter({
      service: 'my-app',
      telegram,
      logger: silentLogger,
      fetchImplementation,
    });
    for (let attempt = 0; attempt < ALERTS_PER_HOUR + 3; attempt += 1) {
      await alerter.alert({ alertType: '5xx GET /api/items', title: 'Server error' });
    }
    expect(requests).toHaveLength(ALERTS_PER_HOUR + 1);
    expect(textOf(requests.at(-1))).toContain('Ops alerts suppressed');
  });

  it('counts through the counter it is given', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const keys: string[] = [];
    const alerter = new OpsAlerter({
      service: 'my-app',
      telegram,
      logger: silentLogger,
      fetchImplementation,
      counter: async ({ key }) => {
        keys.push(key);
        return ALERTS_PER_HOUR + 2;
      },
    });
    await alerter.alert({ alertType: '5xx GET /api/items', title: 'Server error' });
    expect(keys).toEqual(['ops-alert:5xx-get-api-items']);
    expect(requests).toHaveLength(0);
  });

  it('logs a failed send without the bot token and resolves', async () => {
    const lines: string[] = [];
    const logger = pino({}, { write: (line: string) => lines.push(line) });
    const alerter = new OpsAlerter({
      service: 'my-app',
      telegram,
      logger,
      fetchImplementation: createRecordingFetch(500).fetchImplementation,
    });
    await expect(
      alerter.alert({ alertType: 'db', title: 'Database down' }),
    ).resolves.toBeUndefined();
    expect(lines.join('')).toContain('ops_alert_failed');
    expect(lines.join('')).not.toContain('bot-token');
  });
});

describe('createInMemoryAlertCounter', () => {
  it('restarts the count once the window passes', async () => {
    let now = 0;
    const count = createInMemoryAlertCounter(() => now);
    expect(await count({ key: 'a', windowSeconds: 60 })).toBe(1);
    expect(await count({ key: 'a', windowSeconds: 60 })).toBe(2);
    now = 60_000;
    expect(await count({ key: 'a', windowSeconds: 60 })).toBe(1);
  });
});
