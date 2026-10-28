import { sendTelegramMessage } from '../telegram.js';
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
await sendTelegramMessage({
  botToken: required('TELEGRAM_BOT_TOKEN'),
  chatId: required('TELEGRAM_ALERT_CHAT_ID'),
  text: formatWeeklyReport({ weeks, now: new Date() }),
});
console.info(`weekly report sent for ${weeks.length} apps`);
