import { PRODUCTION_ENVIRONMENT } from '../config.js';
import { runHogQLQuery } from './posthog-query.js';
import type { AppWeek, HogQLRows, PostHogQueryOptions, Ranked } from './weekly-report.types.js';

const TOP_COUNT = 3;
// The same rule the sender applies, so events stored before it did still count only from production.
const REAL_TRAFFIC = `properties.app IS NOT NULL AND properties.environment = '${PRODUCTION_ENVIRONMENT}'`;
const THIS_WEEK = 'timestamp >= now() - INTERVAL 7 DAY';
// Page loads outnumber every action, so they get their own line instead of crowding the top list.
const VISIT_EVENTS = "('page_viewed', 'web_ui_visited')";
const IS_VISIT = `event IN ${VISIT_EVENTS}`;
const IS_ACTION = `event NOT IN ${VISIT_EVENTS}`;

const QUERIES = {
  totals: `SELECT properties.app, if(${THIS_WEEK}, 'current', 'previous') AS week,
      countIf(${IS_ACTION}), countIf(${IS_VISIT}), count(DISTINCT distinct_id)
    FROM events WHERE timestamp >= now() - INTERVAL 14 DAY AND ${REAL_TRAFFIC}
    GROUP BY properties.app, week`,
  // "New" means first seen within the project's data retention window.
  newUsers: `SELECT app, count() FROM (
      SELECT properties.app AS app, distinct_id, min(timestamp) AS first_seen
      FROM events WHERE ${REAL_TRAFFIC} GROUP BY app, distinct_id
    ) WHERE first_seen >= now() - INTERVAL 7 DAY GROUP BY app`,
  byUser: `SELECT properties.app, distinct_id, count() FROM events
    WHERE ${THIS_WEEK} AND ${REAL_TRAFFIC} AND ${IS_ACTION}
    GROUP BY properties.app, distinct_id ORDER BY count() DESC LIMIT ${TOP_COUNT} BY properties.app`,
  byEvent: `SELECT properties.app, event, count() FROM events
    WHERE ${THIS_WEEK} AND ${REAL_TRAFFIC} AND ${IS_ACTION}
    GROUP BY properties.app, event ORDER BY count() DESC LIMIT ${TOP_COUNT} BY properties.app`,
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
      actions: 0,
      previousActions: 0,
      visits: 0,
      previousVisits: 0,
      topUsers: [],
      topActions: [],
    };
    weeks.set(app, created);
    return created;
  };

  for (const [app, period, actions, visits, users] of rows.totals) {
    const week = weekOf(String(app));
    if (period === 'current') {
      week.actions = Number(actions);
      week.visits = Number(visits);
      week.activeUsers = Number(users);
    } else {
      week.previousActions = Number(actions);
      week.previousVisits = Number(visits);
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
    weekOf(String(app)).topActions.push({ name: String(event), count: Number(count) });
  }
  return [...weeks.values()].sort(
    (left, right) => right.actions + right.visits - (left.actions + left.visits),
  );
}

export function formatWeeklyReport({ weeks, now }: { weeks: AppWeek[]; now: Date }): string {
  const header = `📊 Weekly report, the 7 days to ${formatDay(now)}`;
  const activeWeeks = weeks.filter(hadActivity);
  if (activeWeeks.length === 0) {
    return `${header}\n\nNo activity in any app.`;
  }
  const sections = activeWeeks.map((week) =>
    [
      `▫️ ${week.app}`,
      `Active users: ${week.activeUsers} ${change({ current: week.activeUsers, previous: week.previousActiveUsers })}`,
      `New users: ${week.newUsers}`,
      `Visits: ${week.visits} ${change({ current: week.visits, previous: week.previousVisits })}`,
      `Actions: ${week.actions} ${change({ current: week.actions, previous: week.previousActions })}`,
      ...listLine({ label: 'Top users', ranked: week.topUsers }),
      ...listLine({ label: 'Top actions', ranked: week.topActions }),
    ].join('\n'),
  );
  return [header, ...sections].join('\n\n');
}

function hadActivity(week: AppWeek): boolean {
  return [week.actions, week.previousActions, week.visits, week.previousVisits].some(
    (count) => count > 0,
  );
}

function withoutAppPrefix({ distinctId, app }: { distinctId: string; app: string }): string {
  const prefix = `${app}:`;
  return distinctId.startsWith(prefix) ? distinctId.slice(prefix.length) : distinctId;
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
