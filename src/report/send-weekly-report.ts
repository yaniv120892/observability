import pino from 'pino';
import { pingHeartbeat } from '../heartbeat.js';
import { sendTelegramMessage, sendTelegramPhoto } from '../telegram.js';
import { renderWeeklyDashboardPng } from './weekly-dashboard.js';
import { collectWeeklyStats, formatWeeklyReport } from './weekly-report.js';

const DEFAULT_POSTHOG_API_HOST = 'https://eu.posthog.com';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set to send the weekly report`);
  }
  return value;
}

const weeks = await collectWeeklyStats({
  apiHost: process.env.POSTHOG_API_HOST?.trim() || DEFAULT_POSTHOG_API_HOST,
  projectId: required('POSTHOG_PROJECT_ID'),
  personalApiKey: required('POSTHOG_PERSONAL_API_KEY'),
});
const now = new Date();
const telegram = {
  botToken: required('TELEGRAM_BOT_TOKEN'),
  chatId: required('TELEGRAM_ALERT_CHAT_ID'),
};
const logger = pino();
// The picture is the at-a-glance view; the text below it still carries every number.
try {
  await sendTelegramPhoto({
    ...telegram,
    photo: renderWeeklyDashboardPng({ weeks, now }),
    fileName: 'weekly-report.png',
  });
} catch (error) {
  logger.warn({ err: error }, 'weekly_dashboard_not_sent');
}
await sendTelegramMessage({ ...telegram, text: formatWeeklyReport({ weeks, now }) });
// A missing ping is how a report that silently stopped running gets noticed.
await pingHeartbeat({
  name: 'BETTERSTACK_HEARTBEAT_WEEKLY_REPORT',
  url: process.env.BETTERSTACK_HEARTBEAT_WEEKLY_REPORT,
  logger,
});
console.info(`weekly report sent for ${weeks.length} apps`);
