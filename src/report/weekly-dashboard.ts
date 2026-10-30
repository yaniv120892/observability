import { Resvg } from '@resvg/resvg-js';
import { formatDay, hadActivity } from './weekly-report.js';
import type { AppWeek } from './weekly-report.types.js';

const WIDTH = 1200;
const PADDING = 40;
const GAP = 24;
const CONTENT_WIDTH = WIDTH - 2 * PADDING;
const HEADER_HEIGHT = 130;
const SUMMARY_HEIGHT = 150;
const APP_CARD_HEIGHT = 200;
const TILE_PADDING = 24;
const BAR_HEIGHT = 8;
const FONT = "Inter, 'Helvetica Neue', Helvetica, Arial, 'DejaVu Sans', sans-serif";

const INK = {
  surface: '#fcfcfb',
  card: '#ffffff',
  border: '#e4e3df',
  primary: '#0b0b0b',
  secondary: '#52514e',
  thisWeek: '#2a78d6',
  lastWeek: '#c3c2b7',
  upIcon: '#0ca30c',
  upText: '#006300',
  down: '#d03b3b',
};

type Metric = { label: string; current: number; previous: number | null };

export function renderWeeklyDashboardPng({ weeks, now }: { weeks: AppWeek[]; now: Date }): Buffer {
  const svg = renderWeeklyDashboardSvg({ weeks, now });
  return new Resvg(svg, { fitTo: { mode: 'zoom', value: 2 } }).render().asPng();
}

export function renderWeeklyDashboardSvg({ weeks, now }: { weeks: AppWeek[]; now: Date }): string {
  const activeWeeks = weeks.filter(hadActivity);
  const appsTop = PADDING + HEADER_HEIGHT + SUMMARY_HEIGHT + GAP;
  const height =
    activeWeeks.length === 0
      ? appsTop + PADDING
      : appsTop + activeWeeks.length * (APP_CARD_HEIGHT + GAP) - GAP + PADDING;
  const body = [
    header(now),
    summary(activeWeeks),
    ...activeWeeks.map((week, index) =>
      appCard({ week, top: appsTop + index * (APP_CARD_HEIGHT + GAP) }),
    ),
  ];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="${FONT}">`,
    `<rect width="${WIDTH}" height="${height}" fill="${INK.surface}"/>`,
    ...body,
    '</svg>',
  ].join('\n');
}

function header(now: Date): string {
  const legendX = WIDTH - PADDING - 260;
  return [
    text({ x: PADDING, y: PADDING + 36, size: 34, weight: 700, content: 'Weekly report' }),
    text({
      x: PADDING,
      y: PADDING + 70,
      size: 18,
      fill: INK.secondary,
      content: `The 7 days to ${formatDay(now)}, compared with the 7 days before`,
    }),
    legendItem({ x: legendX, y: PADDING + 64, color: INK.thisWeek, label: 'This week' }),
    legendItem({ x: legendX + 130, y: PADDING + 64, color: INK.lastWeek, label: 'Last week' }),
  ].join('\n');
}

function legendItem({
  x,
  y,
  color,
  label,
}: {
  x: number;
  y: number;
  color: string;
  label: string;
}): string {
  return [
    `<rect x="${x}" y="${y - 12}" width="14" height="14" rx="3" fill="${color}"/>`,
    text({ x: x + 22, y, size: 16, fill: INK.secondary, content: label }),
  ].join('\n');
}

function summary(weeks: AppWeek[]): string {
  const total = (pick: (week: AppWeek) => number): number =>
    weeks.reduce((sum, week) => sum + pick(week), 0);
  const top = PADDING + HEADER_HEIGHT;
  const heroWidth = (CONTENT_WIDTH - GAP) / 2;
  const sideWidth = (CONTENT_WIDTH - heroWidth - 2 * GAP) / 2;
  const sideMetrics: Metric[] = [
    {
      label: 'Visits',
      current: total((week) => week.visits),
      previous: total((week) => week.previousVisits),
    },
    {
      label: 'Actions',
      current: total((week) => week.actions),
      previous: total((week) => week.previousActions),
    },
  ];
  return [
    card({ x: PADDING, y: top, width: heroWidth, height: SUMMARY_HEIGHT }),
    text({
      x: PADDING + TILE_PADDING,
      y: top + 40,
      size: 17,
      fill: INK.secondary,
      content: `Active users across ${weeks.length} ${weeks.length === 1 ? 'app' : 'apps'}`,
    }),
    valueWithDelta({
      x: PADDING + TILE_PADDING,
      y: top + 110,
      size: 60,
      metric: {
        label: 'Active users',
        current: total((week) => week.activeUsers),
        previous: total((week) => week.previousActiveUsers),
      },
    }),
    ...sideMetrics.map((metric, index) => {
      const x = PADDING + heroWidth + GAP + index * (sideWidth + GAP);
      return [
        card({ x, y: top, width: sideWidth, height: SUMMARY_HEIGHT }),
        metricTile({ x: x + TILE_PADDING, y: top, width: sideWidth - 2 * TILE_PADDING, metric }),
      ].join('\n');
    }),
  ].join('\n');
}

function appCard({ week, top }: { week: AppWeek; top: number }): string {
  const metrics: Metric[] = [
    { label: 'Active users', current: week.activeUsers, previous: week.previousActiveUsers },
    { label: 'New users', current: week.newUsers, previous: null },
    { label: 'Visits', current: week.visits, previous: week.previousVisits },
    { label: 'Actions', current: week.actions, previous: week.previousActions },
  ];
  const innerWidth = CONTENT_WIDTH - 2 * TILE_PADDING;
  const tileWidth = (innerWidth - (metrics.length - 1) * GAP) / metrics.length;
  const topActions = week.topActions
    .map((action) => `${action.name} ${action.count}`)
    .join('  ·  ');
  return [
    card({ x: PADDING, y: top, width: CONTENT_WIDTH, height: APP_CARD_HEIGHT }),
    text({ x: PADDING + TILE_PADDING, y: top + 42, size: 24, weight: 700, content: week.app }),
    topActions
      ? text({
          x: WIDTH - PADDING - TILE_PADDING,
          y: top + 40,
          size: 15,
          fill: INK.secondary,
          anchor: 'end',
          content: `Top actions: ${topActions}`,
        })
      : '',
    ...metrics.map((metric, index) =>
      metricTile({
        x: PADDING + TILE_PADDING + index * (tileWidth + GAP),
        y: top + 50,
        width: tileWidth,
        metric,
      }),
    ),
  ].join('\n');
}

function metricTile({
  x,
  y,
  width,
  metric,
}: {
  x: number;
  y: number;
  width: number;
  metric: Metric;
}): string {
  const parts = [
    text({ x, y: y + 40, size: 16, fill: INK.secondary, content: metric.label }),
    valueWithDelta({ x, y: y + 88, size: 40, metric }),
  ];
  if (metric.previous === null) {
    parts.push(text({ x, y: y + 122, size: 14, fill: INK.secondary, content: 'Joined this week' }));
  } else {
    parts.push(
      comparisonBars({ x, y: y + 106, width, current: metric.current, previous: metric.previous }),
    );
  }
  return parts.join('\n');
}

function comparisonBars({
  x,
  y,
  width,
  current,
  previous,
}: {
  x: number;
  y: number;
  width: number;
  current: number;
  previous: number;
}): string {
  const scale = Math.max(current, previous, 1);
  const barWidth = (count: number): number => Math.max((count / scale) * width, count > 0 ? 4 : 0);
  return [
    `<rect x="${x}" y="${y}" width="${barWidth(current)}" height="${BAR_HEIGHT}" rx="4" fill="${INK.thisWeek}"/>`,
    `<rect x="${x}" y="${y + BAR_HEIGHT + 4}" width="${barWidth(previous)}" height="${BAR_HEIGHT}" rx="4" fill="${INK.lastWeek}"/>`,
  ].join('\n');
}

function valueWithDelta({
  x,
  y,
  size,
  metric,
}: {
  x: number;
  y: number;
  size: number;
  metric: Metric;
}): string {
  const value = formatCount(metric.current);
  // resvg cannot measure text, so the delta's offset estimates the value's width from its digits.
  const deltaX = x + value.length * size * 0.6 + 14;
  return [
    text({ x, y, size, weight: 600, content: value }),
    metric.previous === null
      ? ''
      : delta({
          x: deltaX,
          y: y - size * 0.12,
          current: metric.current,
          previous: metric.previous,
        }),
  ].join('\n');
}

function delta({
  x,
  y,
  current,
  previous,
}: {
  x: number;
  y: number;
  current: number;
  previous: number;
}): string {
  const difference = current - previous;
  if (difference === 0) {
    return text({ x, y, size: 17, fill: INK.secondary, content: 'same' });
  }
  const isUp = difference > 0;
  const triangle = isUp
    ? `M${x} ${y} L${x + 14} ${y} L${x + 7} ${y - 12} Z`
    : `M${x} ${y - 12} L${x + 14} ${y - 12} L${x + 7} ${y} Z`;
  const label = `${isUp ? '+' : '−'}${formatCount(Math.abs(difference))}`;
  return [
    `<path d="${triangle}" fill="${isUp ? INK.upIcon : INK.down}"/>`,
    text({
      x: x + 20,
      y,
      size: 17,
      weight: 600,
      fill: isUp ? INK.upText : INK.down,
      content: label,
    }),
  ].join('\n');
}

function card({
  x,
  y,
  width,
  height,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
}): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="16" fill="${INK.card}" stroke="${INK.border}"/>`;
}

function text({
  x,
  y,
  size,
  content,
  weight = 400,
  fill = INK.primary,
  anchor = 'start',
}: {
  x: number;
  y: number;
  size: number;
  content: string;
  weight?: number;
  fill?: string;
  anchor?: 'start' | 'end';
}): string {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escapeXml(content)}</text>`;
}

function formatCount(count: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
    count,
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
