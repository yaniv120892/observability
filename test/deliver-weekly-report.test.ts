import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { deliverWeeklyReport } from '../src/report/deliver-weekly-report.js';
import type { AppWeek } from '../src/report/weekly-report.types.js';

const NOW = new Date('2026-11-01T07:00:00Z');
const ACTIVE_WEEK: AppWeek = {
  app: 'expenses',
  activeUsers: 2,
  previousActiveUsers: 1,
  newUsers: 1,
  actions: 5,
  previousActions: 3,
  visits: 4,
  previousVisits: 4,
  topUsers: [],
  topActions: [{ name: 'expense_created', count: 5 }],
};

function capturingLogger() {
  const messages: string[] = [];
  const logger = pino({}, { write: (line: string) => messages.push(JSON.parse(line).msg) });
  return { logger, messages };
}

function telegramAnswering({ photoStatus }: { photoStatus: number }) {
  const methods: string[] = [];
  async function respond(input: string | URL | Request): Promise<Response> {
    const method = String(input).split('/').pop() ?? '';
    methods.push(method);
    const status = method === 'sendPhoto' ? photoStatus : 200;
    return new Response(JSON.stringify({ description: 'Bad Request: PHOTO_INVALID' }), { status });
  }
  return { methods, fetchImplementation: respond };
}

async function deliver({ weeks, photoStatus }: { weeks: AppWeek[]; photoStatus: number }) {
  const { logger, messages } = capturingLogger();
  const { methods, fetchImplementation } = telegramAnswering({ photoStatus });
  const outcome = await deliverWeeklyReport({
    weeks,
    now: NOW,
    botToken: 'secret-token',
    chatId: '42',
    logger,
    fetchImplementation,
  });
  return { outcome, methods, messages };
}

describe('deliverWeeklyReport', () => {
  it('sends the dashboard picture, then the text', async () => {
    const { outcome, methods } = await deliver({ weeks: [ACTIVE_WEEK], photoStatus: 200 });

    expect(methods).toEqual(['sendPhoto', 'sendMessage']);
    expect(outcome).toBe('sent');
  });

  it('still sends the text when Telegram refuses the picture', async () => {
    const { outcome, methods, messages } = await deliver({
      weeks: [ACTIVE_WEEK],
      photoStatus: 400,
    });

    expect(methods).toEqual(['sendPhoto', 'sendMessage']);
    expect(messages).toContain('weekly_dashboard_not_sent');
    expect(outcome).toBe('failed');
  });

  it('sends no picture in a week with no activity', async () => {
    const { outcome, methods } = await deliver({ weeks: [], photoStatus: 200 });

    expect(methods).toEqual(['sendMessage']);
    expect(outcome).toBe('skipped');
  });
});
