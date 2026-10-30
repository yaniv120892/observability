import { describe, expect, it } from 'vitest';
import {
  renderWeeklyDashboardPng,
  renderWeeklyDashboardSvg,
} from '../src/report/weekly-dashboard.js';
import type { AppWeek } from '../src/report/weekly-report.types.js';

const NOW = new Date('2026-11-01T07:00:00Z');
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

function appWeek(overrides: Partial<AppWeek> & { app: string }): AppWeek {
  return {
    activeUsers: 0,
    previousActiveUsers: 0,
    newUsers: 0,
    actions: 0,
    previousActions: 0,
    visits: 0,
    previousVisits: 0,
    topUsers: [],
    topActions: [],
    ...overrides,
  };
}

describe('weekly dashboard', () => {
  it('draws a card per active app with its numbers and week-over-week changes', () => {
    const svg = renderWeeklyDashboardSvg({
      now: NOW,
      weeks: [
        appWeek({
          app: 'expenses',
          activeUsers: 4,
          previousActiveUsers: 3,
          actions: 90,
          previousActions: 120,
          visits: 40,
          previousVisits: 40,
          topActions: [{ name: 'expense_created', count: 80 }],
        }),
        appWeek({ app: 'quiet-app' }),
      ],
    });

    expect(svg).toContain('>expenses<');
    expect(svg).toContain('>+1<');
    expect(svg).toContain('>−30<');
    expect(svg).toContain('>same<');
    expect(svg).toContain('Top actions: expense_created 80');
    expect(svg).toContain('Active users across 1 app');
    expect(svg).not.toContain('quiet-app');
  });

  it('escapes names that would break the SVG', () => {
    const svg = renderWeeklyDashboardSvg({
      now: NOW,
      weeks: [appWeek({ app: 'a<b>&"c"', actions: 1 })],
    });

    expect(svg).toContain('a&lt;b&gt;&amp;&quot;c&quot;');
  });

  it('renders a PNG Telegram can send as a photo', () => {
    const png = renderWeeklyDashboardPng({
      now: NOW,
      weeks: [appWeek({ app: 'expenses', actions: 3, visits: 2, activeUsers: 1 })],
    });

    expect([...png.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
  });
});
