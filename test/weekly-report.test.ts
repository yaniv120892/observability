import { describe, expect, it, vi } from 'vitest';
import { runHogQLQuery } from '../src/report/posthog-query.js';
import { collectWeeklyStats, formatWeeklyReport, toAppWeeks } from '../src/report/weekly-report.js';
import { jsonBodyOf } from './fakes/recording-fetch.js';

const NOW = new Date('2026-11-01T07:00:00Z');

describe('weekly report', () => {
  it('builds each app week from the query rows, without the app prefix on users', () => {
    const weeks = toAppWeeks({
      totals: [
        ['expenses', 'current', 120, 40, 4],
        ['expenses', 'previous', 100, 30, 3],
        ['arbox', 'current', 9, 2, 1],
      ],
      newUsers: [['expenses', 2]],
      byUser: [
        ['expenses', 'expenses:42', 80],
        ['expenses', 'expenses:7', 30],
        ['arbox', 'arbox:owner', 9],
      ],
      byEvent: [['expenses', 'expense_created', 100]],
    });

    expect(weeks.map((week) => week.app)).toEqual(['expenses', 'arbox']);
    expect(weeks[0]).toMatchObject({
      activeUsers: 4,
      previousActiveUsers: 3,
      newUsers: 2,
      events: 120,
      previousEvents: 100,
      visits: 40,
      previousVisits: 30,
      topUsers: [
        { name: '42', count: 80 },
        { name: '7', count: 30 },
      ],
    });
  });

  it('formats one section per app with week-over-week changes', () => {
    const text = formatWeeklyReport({
      now: NOW,
      weeks: [
        {
          app: 'expenses',
          activeUsers: 4,
          previousActiveUsers: 3,
          newUsers: 2,
          events: 120,
          previousEvents: 120,
          visits: 40,
          previousVisits: 50,
          topUsers: [{ name: '42', count: 80 }],
          topEvents: [{ name: 'expense_created', count: 100 }],
        },
      ],
    });

    expect(text).toBe(
      [
        '📊 Weekly report, the 7 days to 01/11',
        '',
        '▫️ expenses',
        'Active users: 4 (+1 vs last week)',
        'New users: 2',
        'Visits: 40 (-10 vs last week)',
        'Actions: 120 (same as last week)',
        'Top users: 42 (80)',
        'Top actions: expense_created (100)',
      ].join('\n'),
    );
  });

  it('keeps an app whose week had only page visits', () => {
    const text = formatWeeklyReport({
      now: NOW,
      weeks: toAppWeeks({
        totals: [['shopping', 'current', 0, 5, 1]],
        newUsers: [],
        byUser: [],
        byEvent: [],
      }),
    });
    expect(text).toContain('▫️ shopping\n');
    expect(text).toContain('Visits: 5 (+5 vs last week)');
  });

  it('says so when no app had any activity', () => {
    expect(formatWeeklyReport({ now: NOW, weeks: [] })).toContain('No activity in any app.');
  });

  it('queries PostHog with the personal key and returns the rows', async () => {
    const fetchImplementation = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ results: [['expenses', 3]] }), { status: 200 }),
    );

    const rows = await runHogQLQuery({
      query: 'SELECT 1',
      apiHost: 'https://eu.posthog.com',
      projectId: '123',
      personalApiKey: 'phx_secret',
      fetchImplementation,
    });

    expect(rows).toEqual([['expenses', 3]]);
    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    expect(url).toBe('https://eu.posthog.com/api/projects/123/query/');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer phx_secret' });
    expect(jsonBodyOf({ url: String(url), init })).toEqual({
      query: { kind: 'HogQLQuery', query: 'SELECT 1' },
    });
  });

  it('ranks top actions without page visits', async () => {
    const queries: string[] = [];
    const fetchImplementation = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        queries.push(String(init?.body));
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      },
    );

    await collectWeeklyStats({
      apiHost: 'https://eu.posthog.com',
      projectId: '123',
      personalApiKey: 'phx_secret',
      fetchImplementation,
    });

    const topActionsQuery = queries.find((query) => query.includes('event, count()'));
    expect(topActionsQuery).toContain("NOT event IN ('page_viewed', 'web_ui_visited')");
  });

  it('fails loudly when PostHog rejects the query', async () => {
    const fetchImplementation = vi.fn(async () => new Response('bad key', { status: 403 }));

    await expect(
      runHogQLQuery({
        query: 'SELECT 1',
        apiHost: 'https://eu.posthog.com',
        projectId: '123',
        personalApiKey: 'phx_secret',
        fetchImplementation,
      }),
    ).rejects.toThrow('PostHog query answered 403: bad key');
  });
});
