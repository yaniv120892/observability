import { describe, expect, it } from 'vitest';
import {
  renderWeeklyDashboardPng,
  renderWeeklyDashboardSvg,
} from '../src/report/weekly-dashboard.js';
import type { AppWeek } from '../src/report/weekly-report.types.js';

const NOW = new Date('2026-11-01T07:00:00Z');
const TELEGRAM_MAX_PHOTO_SIDES = 10_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

// Any week fields a test cares about; the rest are zero.
type AppWeekOverrides = Partial<AppWeek> & { app: string };

function appWeek(overrides: AppWeekOverrides): AppWeek {
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
    expect(svg).toContain('Active users, summed across 1 app');
    expect(svg).not.toContain('quiet-app');
  });

  it('shows exact numbers below ten thousand and compacts the rest', () => {
    const svg = renderWeeklyDashboardSvg({
      now: NOW,
      weeks: [appWeek({ app: 'expenses', visits: 1249, previousVisits: 1150, actions: 12_900 })],
    });

    expect(svg).toContain('>1,249<');
    expect(svg).toContain('>+99<');
    expect(svg).toContain('>12.9K<');
  });

  it('cuts a long top-actions line short', () => {
    const longName = 'a_very_long_event_name_that_keeps_going';
    const svg = renderWeeklyDashboardSvg({
      now: NOW,
      weeks: [
        appWeek({
          app: 'expenses',
          actions: 3,
          topActions: [1, 2, 3, 4].map((count) => ({ name: `${longName}_${count}`, count })),
        }),
      ],
    });

    expect(svg).toContain('…<');
    expect(svg).not.toContain(`${longName}_4`);
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

  it('keeps a picture of many apps within the size Telegram accepts', () => {
    const weeks = Array.from({ length: 40 }, (_, index) =>
      appWeek({ app: `app-${index}`, actions: 1 }),
    );

    const png = renderWeeklyDashboardPng({ now: NOW, weeks });

    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width + height).toBeLessThanOrEqual(TELEGRAM_MAX_PHOTO_SIDES);
  });
});
