import { Resvg } from '@resvg/resvg-js';
import { formatDay, hadActivity } from './weekly-report.js';
import type { AppWeek } from './weekly-report.types.js';

const WIDTH = 1200;
const PADDING = 40;
const GAP = 24;
const CONTENT_WIDTH = WIDTH - 2 * PADDING;
const HEADER_HEIGHT = 130;
const SUMMARY_HEIGHT = 150;
const APP_CARD_HEIGHT = 222;
const APPS_TOP = PADDING + HEADER_HEIGHT + SUMMARY_HEIGHT + GAP;
const TILE_PADDING = 24;
const BAR_HEIGHT = 8;
const TOP_ACTIONS_MAX_LENGTH = 120;
// Telegram refuses a photo whose width and height add up to more than this.
const TELEGRAM_MAX_PHOTO_SIDES = 10_000;
const PREFERRED_ZOOM = 2;
const COMPACT_FROM = 10_000;
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

type Box = { x: number; y: number; width: number };

export function renderWeeklyDashboardPng({ weeks, now }: { weeks: AppWeek[]; now: Date }): Buffer {
  const svg = renderWeeklyDashboardSvg({ weeks, now });
  const height = dashboardHeight(weeks.filter(hadActivity).length);
  const zoom = Math.min(PREFERRED_ZOOM, (TELEGRAM_MAX_PHOTO_SIDES - 1) / (WIDTH + height));
  return new Resvg(svg, { fitTo: { mode: 'zoom', value: zoom } }).render().asPng();
}

export function renderWeeklyDashboardSvg({ weeks, now }: { weeks: AppWeek[]; now: Date }): string {
  const activeWeeks = weeks.filter(hadActivity);
  const height = dashboardHeight(activeWeeks.length);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="${FONT}">`,
    `<rect width="${WIDTH}" height="${height}" fill="${INK.surface}"/>`,
    header(now),
    summary(activeWeeks),
    ...activeWeeks.map((week, index) =>
      appCard({ week, top: APPS_TOP + index * (APP_CARD_HEIGHT + GAP) }),
    ),
    '</svg>',
  ].join('\n');
}

function dashboardHeight(appCount: number): number {
  const appsHeight = Math.max(0, appCount * (APP_CARD_HEIGHT + GAP) - GAP);
  return APPS_TOP + appsHeight + PADDING;
}

function weekMetrics(week: AppWeek): Metric[] {
  return [
    { label: 'Active users', current: week.activeUsers, previous: week.previousActiveUsers },
    { label: 'New users', current: week.newUsers, previous: null },
    { label: 'Visits', current: week.visits, previous: week.previousVisits },
    { label: 'Actions', current: week.actions, previous: week.previousActions },
  ];
}

function summedMetric({ weeks, label }: { weeks: AppWeek[]; label: string }): Metric {
  const perApp = weeks.map((week) => weekMetrics(week).find((metric) => metric.label === label));
  return {
    label,
    current: perApp.reduce((sum, metric) => sum + (metric?.current ?? 0), 0),
    previous: perApp.reduce((sum, metric) => sum + (metric?.previous ?? 0), 0),
  };
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
  const top = PADDING + HEADER_HEIGHT;
  const heroWidth = (CONTENT_WIDTH - GAP) / 2;
  const sideWidth = (CONTENT_WIDTH - heroWidth - 2 * GAP) / 2;
  const appCount = `${weeks.length} ${weeks.length === 1 ? 'app' : 'apps'}`;
  const hero: Metric = {
    ...summedMetric({ weeks, label: 'Active users' }),
    // A person active in two apps counts in both, so the label says it is a sum.
    label: `Active users, summed across ${appCount}`,
  };
  const sideMetrics = ['Visits', 'Actions'].map((label) => summedMetric({ weeks, label }));
  return [
    card({ x: PADDING, y: top, width: heroWidth, height: SUMMARY_HEIGHT }),
    metricTile({
      box: { x: PADDING + TILE_PADDING, y: top, width: heroWidth - 2 * TILE_PADDING },
      metric: hero,
      valueSize: 60,
    }),
    ...sideMetrics.map((metric, index) => {
      const x = PADDING + heroWidth + GAP + index * (sideWidth + GAP);
      return [
        card({ x, y: top, width: sideWidth, height: SUMMARY_HEIGHT }),
        metricTile({
          box: { x: x + TILE_PADDING, y: top, width: sideWidth - 2 * TILE_PADDING },
          metric,
          valueSize: 40,
        }),
      ].join('\n');
    }),
  ].join('\n');
}

function appCard({ week, top }: { week: AppWeek; top: number }): string {
  const metrics = weekMetrics(week);
  const innerWidth = CONTENT_WIDTH - 2 * TILE_PADDING;
  const tileWidth = (innerWidth - (metrics.length - 1) * GAP) / metrics.length;
  const topActions = week.topActions
    .map((action) => `${action.name} ${action.count}`)
    .join('  ·  ');
  const parts = [
    card({ x: PADDING, y: top, width: CONTENT_WIDTH, height: APP_CARD_HEIGHT }),
    text({ x: PADDING + TILE_PADDING, y: top + 42, size: 24, weight: 700, content: week.app }),
    ...metrics.map((metric, index) =>
      metricTile({
        box: {
          x: PADDING + TILE_PADDING + index * (tileWidth + GAP),
          y: top + 50,
          width: tileWidth,
        },
        metric,
        valueSize: 40,
      }),
    ),
  ];
  if (topActions) {
    parts.push(
      text({
        x: PADDING + TILE_PADDING,
        y: top + APP_CARD_HEIGHT - 22,
        size: 15,
        fill: INK.secondary,
        content: truncate(`Top actions: ${topActions}`),
      }),
    );
  }
  return parts.join('\n');
}

function metricTile({
  box,
  metric,
  valueSize,
}: {
  box: Box;
  metric: Metric;
  valueSize: number;
}): string {
  const valueY = box.y + 48 + valueSize * 0.8;
  const parts = [
    text({ x: box.x, y: box.y + 40, size: 16, fill: INK.secondary, content: metric.label }),
    text({
      x: box.x,
      y: valueY,
      size: valueSize,
      weight: 600,
      content: formatCount(metric.current),
    }),
  ];
  if (metric.previous === null) {
    parts.push(
      text({
        x: box.x,
        y: valueY + 34,
        size: 14,
        fill: INK.secondary,
        content: 'Joined this week',
      }),
    );
  } else {
    parts.push(
      // resvg cannot measure text, so the change sits at the tile's right edge instead of after the value.
      delta({ right: box.x + box.width, y: valueY - 8, ...metric, previous: metric.previous }),
      comparisonBars({ box: { ...box, y: valueY + 18 }, ...metric, previous: metric.previous }),
    );
  }
  return parts.join('\n');
}

function comparisonBars({
  box,
  current,
  previous,
}: {
  box: Box;
  current: number;
  previous: number;
}): string {
  const scale = Math.max(current, previous, 1);
  const barWidth = (count: number): number =>
    Math.max((count / scale) * box.width, count > 0 ? 4 : 0);
  return [
    `<rect x="${box.x}" y="${box.y}" width="${barWidth(current)}" height="${BAR_HEIGHT}" rx="4" fill="${INK.thisWeek}"/>`,
    `<rect x="${box.x}" y="${box.y + BAR_HEIGHT + 4}" width="${barWidth(previous)}" height="${BAR_HEIGHT}" rx="4" fill="${INK.lastWeek}"/>`,
  ].join('\n');
}

function delta({
  right,
  y,
  current,
  previous,
}: {
  right: number;
  y: number;
  current: number;
  previous: number;
}): string {
  const difference = current - previous;
  if (difference === 0) {
    return text({ x: right, y, size: 17, fill: INK.secondary, anchor: 'end', content: 'same' });
  }
  const isUp = difference > 0;
  const triangleLeft = right - 14;
  const triangle = isUp
    ? `M${triangleLeft} ${y} L${right} ${y} L${triangleLeft + 7} ${y - 12} Z`
    : `M${triangleLeft} ${y - 12} L${right} ${y - 12} L${triangleLeft + 7} ${y} Z`;
  return [
    `<path d="${triangle}" fill="${isUp ? INK.upIcon : INK.down}"/>`,
    text({
      x: triangleLeft - 6,
      y,
      size: 17,
      weight: 600,
      fill: isUp ? INK.upText : INK.down,
      anchor: 'end',
      content: `${isUp ? '+' : '−'}${formatCount(Math.abs(difference))}`,
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

function truncate(value: string): string {
  return value.length > TOP_ACTIONS_MAX_LENGTH
    ? `${value.slice(0, TOP_ACTIONS_MAX_LENGTH - 1)}…`
    : value;
}

function formatCount(count: number): string {
  const notation = count >= COMPACT_FROM ? 'compact' : 'standard';
  return new Intl.NumberFormat('en', { notation, maximumFractionDigits: 1 }).format(count);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
