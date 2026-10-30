import pino from 'pino';
import { pingHeartbeat } from '../heartbeat.js';
import { deliverWeeklyReport } from './deliver-weekly-report.js';
import { collectWeeklyStats } from './weekly-report.js';

const DEFAULT_POSTHOG_API_HOST = 'https://eu.posthog.com';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set to send the weekly report`);
  }
  return value;
}

const logger = pino();
const weeks = await collectWeeklyStats({
  apiHost: process.env.POSTHOG_API_HOST?.trim() || DEFAULT_POSTHOG_API_HOST,
  projectId: required('POSTHOG_PROJECT_ID'),
  personalApiKey: required('POSTHOG_PERSONAL_API_KEY'),
});
const dashboard = await deliverWeeklyReport({
  weeks,
  now: new Date(),
  botToken: required('TELEGRAM_BOT_TOKEN'),
  chatId: required('TELEGRAM_ALERT_CHAT_ID'),
  logger,
});
// A missing ping is how a report that silently stopped running gets noticed.
await pingHeartbeat({
  name: 'BETTERSTACK_HEARTBEAT_WEEKLY_REPORT',
  url: process.env.BETTERSTACK_HEARTBEAT_WEEKLY_REPORT,
  logger,
});
console.info(`weekly report sent for ${weeks.length} apps (dashboard ${dashboard})`);
// The text already went out; a red run is what makes a picture that keeps failing get noticed.
if (dashboard === 'failed') {
  process.exitCode = 1;
}
