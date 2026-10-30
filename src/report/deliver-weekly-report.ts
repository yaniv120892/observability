import type { Logger } from 'pino';
import { sendTelegramMessage, sendTelegramPhoto } from '../telegram.js';
import { formatWeeklyReport, hadActivity } from './weekly-report.js';
import type { AppWeek } from './weekly-report.types.js';

export type DashboardOutcome = 'sent' | 'skipped' | 'failed';

export async function deliverWeeklyReport({
  weeks,
  now,
  botToken,
  chatId,
  logger,
  fetchImplementation = fetch,
}: {
  weeks: AppWeek[];
  now: Date;
  botToken: string;
  chatId: string;
  logger: Logger;
  fetchImplementation?: typeof fetch;
}): Promise<DashboardOutcome> {
  const dashboard = await sendDashboard({
    weeks,
    now,
    botToken,
    chatId,
    logger,
    fetchImplementation,
  });
  await sendTelegramMessage({
    botToken,
    chatId,
    text: formatWeeklyReport({ weeks, now }),
    fetchImplementation,
  });
  return dashboard;
}

async function sendDashboard({
  weeks,
  now,
  botToken,
  chatId,
  logger,
  fetchImplementation,
}: {
  weeks: AppWeek[];
  now: Date;
  botToken: string;
  chatId: string;
  logger: Logger;
  fetchImplementation: typeof fetch;
}): Promise<DashboardOutcome> {
  if (!weeks.some(hadActivity)) {
    return 'skipped';
  }
  try {
    // Loaded here, not at the top: the renderer is a native binding, and one that fails to load
    // must cost only the picture.
    const { renderWeeklyDashboardPng } = await import('./weekly-dashboard.js');
    await sendTelegramPhoto({
      botToken,
      chatId,
      photo: renderWeeklyDashboardPng({ weeks, now }),
      fileName: 'weekly-report.png',
      fetchImplementation,
    });
    return 'sent';
  } catch (error) {
    logger.warn({ err: error }, 'weekly_dashboard_not_sent');
    return 'failed';
  }
}
