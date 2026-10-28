import { runHogQLQuery } from './posthog-query.js';
import type { AppWeek, HogQLRows, PostHogQueryOptions, Ranked } from './weekly-report.types.js';

const TOP_COUNT = 3;
// Local runs and preview deploys would otherwise count as real users.
const REAL_TRAFFIC = "properties.environment NOT IN ('development', 'preview', 'test')";
const THIS_WEEK = 'timestamp >= now() - INTERVAL 7 DAY';

const QUERIES = {
  totals: `SELECT properties.app, ${THIS_WEEK}, count(), count(DISTINCT distinct_id)
    FROM events WHERE timestamp >= now() - INTERVAL 14 DAY AND ${REAL_TRAFFIC}
    GROUP BY properties.app, ${THIS_WEEK}`,
  newUsers: `SELECT app, count() FROM (
      SELECT properties.app AS app, distinct_id, min(timestamp) AS first_seen
      FROM events WHERE ${REAL_TRAFFIC} GROUP BY app, distinct_id
    ) WHERE first_seen >= now() - INTERVAL 7 DAY GROUP BY app`,
  byUser: `SELECT properties.app, distinct_id, count() FROM events
    WHERE ${THIS_WEEK} AND ${REAL_TRAFFIC}
    GROUP BY properties.app, distinct_id ORDER BY count() DESC LIMIT 1000`,
  byEvent: `SELECT properties.app, event, count() FROM events
    WHERE ${THIS_WEEK} AND ${REAL_TRAFFIC}
    GROUP BY properties.app, event ORDER BY count() DESC LIMIT 1000`,
};

export async function collectWeeklyStats(options: PostHogQueryOptions): Promise<AppWeek[]> {
  const [totals, newUsers, byUser, byEvent] = await Promise.all([
    runHogQLQuery({ ...options, query: QUERIES.totals }),
    runHogQLQuery({ ...options, query: QUERIES.newUsers }),
    runHogQLQuery({ ...options, query: QUERIES.byUser }),
    runHogQLQuery({ ...options, query: QUERIES.byEvent }),
  ]);
  return toAppWeeks({ totals, newUsers, byUser, byEvent });
}

export function toAppWeeks(rows: {
  totals: HogQLRows;
  newUsers: HogQLRows;
  byUser: HogQLRows;
  byEvent: HogQLRows;
}): AppWeek[] {
  const weeks = new Map<string, AppWeek>();
  const weekOf = (app: string): AppWeek => {
    const existing = weeks.get(app);
    if (existing) {
      return existing;
    }
    const created: AppWeek = {
      app,
      activeUsers: 0,
      previousActiveUsers: 0,
      newUsers: 0,
      events: 0,
      previousEvents: 0,
      topUsers: [],
      topEvents: [],
    };
    weeks.set(app, created);
    return created;
  };

  for (const [app, isThisWeek, events, users] of rows.totals) {
    const week = weekOf(String(app));
    const isCurrent = isThisWeek === true || isThisWeek === 1;
    if (isCurrent) {
      week.events = Number(events);
      week.activeUsers = Number(users);
    } else {
      week.previousEvents = Number(events);
      week.previousActiveUsers = Number(users);
    }
  }
  for (const [app, count] of rows.newUsers) {
    weekOf(String(app)).newUsers = Number(count);
  }
  for (const [app, distinctId, count] of rows.byUser) {
    const week = weekOf(String(app));
    week.topUsers.push({
      name: withoutAppPrefix({ distinctId: String(distinctId), app: week.app }),
      count: Number(count),
    });
  }
  for (const [app, event, count] of rows.byEvent) {
    weekOf(String(app)).topEvents.push({ name: String(event), count: Number(count) });
  }
  return [...weeks.values()]
    .map((week) => ({
      ...week,
      topUsers: topOf(week.topUsers),
      topEvents: topOf(week.topEvents),
    }))
    .sort((left, right) => right.events - left.events);
}

export function formatWeeklyReport({ weeks, now }: { weeks: AppWeek[]; now: Date }): string {
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const header = `📊 Weekly report, ${formatDay(weekStart)} to ${formatDay(now)}`;
  const activeWeeks = weeks.filter((week) => week.events > 0 || week.previousEvents > 0);
  if (activeWeeks.length === 0) {
    return `${header}\n\nNo activity in any app.`;
  }
  const sections = activeWeeks.map((week) =>
    [
      `▫️ ${week.app}`,
      `Active users: ${week.activeUsers} ${change({ current: week.activeUsers, previous: week.previousActiveUsers })}`,
      `New users: ${week.newUsers}`,
      `Actions: ${week.events} ${change({ current: week.events, previous: week.previousEvents })}`,
      ...listLine({ label: 'Top users', ranked: week.topUsers }),
      ...listLine({ label: 'Top actions', ranked: week.topEvents }),
    ].join('\n'),
  );
  return [header, ...sections].join('\n\n');
}

function withoutAppPrefix({ distinctId, app }: { distinctId: string; app: string }): string {
  const prefix = `${app}:`;
  return distinctId.startsWith(prefix) ? distinctId.slice(prefix.length) : distinctId;
}

function topOf(ranked: Ranked[]): Ranked[] {
  return [...ranked].sort((left, right) => right.count - left.count).slice(0, TOP_COUNT);
}

function change({ current, previous }: { current: number; previous: number }): string {
  const difference = current - previous;
  if (difference === 0) {
    return '(same as last week)';
  }
  const sign = difference > 0 ? '+' : '';
  return `(${sign}${difference} vs last week)`;
}

function listLine({ label, ranked }: { label: string; ranked: Ranked[] }): string[] {
  if (ranked.length === 0) {
    return [];
  }
  return [`${label}: ${ranked.map((entry) => `${entry.name} (${entry.count})`).join(', ')}`];
}

function formatDay(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Asia/Jerusalem',
  });
}
