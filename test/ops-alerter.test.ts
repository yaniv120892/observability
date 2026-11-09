import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALERTS_PER_HOUR, createInMemoryAlertCounter, OpsAlerter } from '../src/ops-alerter.js';
import { PrismaClientKnownRequestError, WITHHELD_PRISMA_MESSAGE } from './fakes/prisma-error.js';
import { createRecordingFetch, jsonBodyOf } from './fakes/recording-fetch.js';
import type { RecordedRequest } from './fakes/recording-fetch.types.js';

const telegram = { botToken: 'bot-token', chatId: '42' };
const silentLogger = pino({ level: 'silent' });

function textOf(request: RecordedRequest | undefined): string {
  const body = jsonBodyOf(request);
  if (typeof body !== 'object' || body === null || !('text' in body)) {
    throw new Error('Telegram request had no text');
  }
  return String(body.text);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OpsAlerter', () => {
  it('withholds a Prisma error message by default', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const alerter = new OpsAlerter({
      service: 'my-app',
      telegram,
      logger: silentLogger,
      fetchImplementation,
    });
    await alerter.alert({
      alertType: 'db',
      title: 'Insert failed',
      error: new PrismaClientKnownRequestError(),
    });
    expect(textOf(requests[0])).toBe(
      `🚨 [my-app] Insert failed\nPrismaClientKnownRequestError: ${WITHHELD_PRISMA_MESSAGE}`,
    );
  });

  it('redacts secrets and hashes contact details in the context it sends', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const alerter = new OpsAlerter({
      service: 'my-app',
      telegram,
      logger: silentLogger,
      fetchImplementation,
      secretKeys: ['setupCode'],
    });
    await alerter.alert({
      alertType: 'invite',
      title: 'Invite failed',
      context: { email: 'dana@example.com', inviteCode: 'plain', setupCode: 'plain', route: '/x' },
    });
    const text = textOf(requests[0]);
    expect(text).not.toMatch(/plain|dana@example\.com/);
    expect(text).toMatch(
      /email: sha256:[0-9a-f]{12}\ninviteCode: \[redacted\]\nsetupCode: \[redacted\]\nroute: \/x$/,
    );
  });

  it('counts in this instance when the shared counter does not answer within a second', async () => {
    vi.useFakeTimers();
    const { requests, fetchImplementation } = createRecordingFetch();
    const warnings: unknown[] = [];
    const logger = pino(
      { level: 'warn' },
      { write: (line: string) => warnings.push(JSON.parse(line).msg) },
    );
    const alerter = new OpsAlerter({
      service: 'my-app',
      telegram,
      logger,
      counter: () => new Promise<number>(() => undefined),
      fetchImplementation,
    });
    const alerting = alerter.alert({ alertType: 'db', title: 'Database down' });
    await vi.advanceTimersByTimeAsync(1000);
    await alerting;
    expect(requests).toHaveLength(1);
    expect(warnings).toContain('ops_alert_counter_failed');
  });

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

describe('OpsAlerter when its shared counter is down', () => {
  it('falls back to counting in this instance and still alerts', async () => {
    const { requests, fetchImplementation } = createRecordingFetch();
    const alerter = new OpsAlerter({
      service: 'my-app',
      telegram,
      logger: silentLogger,
      fetchImplementation,
      counter: async () => {
        throw new Error('redis unreachable');
      },
    });
    await alerter.alert({ alertType: 'db', title: 'Database down' });
    expect(requests).toHaveLength(1);
  });

  it('logs every alert, sent or not', async () => {
    const messages: string[] = [];
    const logger = pino({}, { write: (line: string) => messages.push(JSON.parse(line).msg) });
    const alerter = new OpsAlerter({ service: 'my-app', telegram: null, logger });
    await alerter.alert({ alertType: 'db', title: 'Database down' });
    expect(messages).toEqual(['ops_alert']);
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
