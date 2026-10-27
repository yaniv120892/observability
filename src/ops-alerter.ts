import type { Logger } from 'pino';
import { sendTelegramMessage } from './telegram.js';
import type { AlertCounter, OpsAlert } from './ops-alerter.types.js';

type OpsAlerterOptions = {
  service: string;
  telegram: { botToken: string; chatId: string } | null;
  logger: Logger;
  /** Defaults to a per-process count; pass a shared store's counter to cap across instances. */
  counter?: AlertCounter;
  fetchImplementation?: typeof fetch;
};

export const ALERTS_PER_HOUR = 5;
const WINDOW_SECONDS = 60 * 60;
const SUPPRESSION_NOTICE_COUNT = ALERTS_PER_HOUR + 1;

/** Counts per process: a cold start resets it and N instances can each send their own cap. */
export function createInMemoryAlertCounter(now: () => number = Date.now): AlertCounter {
  const windows = new Map<string, { startedAt: number; count: number }>();
  return async function countInMemory({ key, windowSeconds }) {
    const current = now();
    const window = windows.get(key);
    if (!window || current - window.startedAt >= windowSeconds * 1000) {
      windows.set(key, { startedAt: current, count: 1 });
      return 1;
    }
    window.count += 1;
    return window.count;
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return error === undefined || error === null ? '' : String(error);
}

function quotaKey(alertType: string): string {
  const normalized = alertType
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 80);
  return `ops-alert:${normalized}`;
}

/**
 * Tells the owner, on Telegram, about a problem they must act on. It goes straight to the Bot API
 * and depends on nothing that might be what broke. Capped per alert type; the alert past the cap
 * becomes a notice, so the silence that follows is never ambiguous. `alert` always resolves.
 */
export class OpsAlerter {
  private readonly service: string;
  private readonly telegram: { botToken: string; chatId: string } | null;
  private readonly logger: Logger;
  private readonly counter: AlertCounter;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: OpsAlerterOptions) {
    this.service = options.service;
    this.telegram = options.telegram;
    this.logger = options.logger;
    this.counter = options.counter ?? createInMemoryAlertCounter();
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public get isEnabled(): boolean {
    return this.telegram !== null;
  }

  public async alert(alert: OpsAlert): Promise<void> {
    if (!this.telegram) {
      return;
    }
    try {
      const count = await this.counter({
        key: quotaKey(alert.alertType),
        windowSeconds: WINDOW_SECONDS,
      });
      if (count > SUPPRESSION_NOTICE_COUNT) {
        return;
      }
      await sendTelegramMessage({
        ...this.telegram,
        text:
          count === SUPPRESSION_NOTICE_COUNT
            ? this.formatSuppressionNotice(alert.alertType)
            : this.format(alert),
        fetchImplementation: this.fetchImplementation,
      });
    } catch (error) {
      // Only the message: a fetch error's cause can carry the request, whose URL holds the token.
      this.logger.error(
        { reason: errorMessage(error), alertType: alert.alertType },
        'ops_alert_failed',
      );
    }
  }

  private format({ title, error, context }: OpsAlert): string {
    const lines = [`🚨 [${this.service}] ${title}`];
    const message = errorMessage(error);
    if (message) {
      lines.push(message);
    }
    for (const [key, value] of Object.entries(context ?? {})) {
      if (value !== undefined && value !== null) {
        lines.push(`${key}: ${value}`);
      }
    }
    return lines.join('\n');
  }

  private formatSuppressionNotice(alertType: string): string {
    return [
      `🔇 [${this.service}] Ops alerts suppressed`,
      `More than ${ALERTS_PER_HOUR} "${alertType}" alerts this hour.`,
      'Further alerts of this type are dropped until the window resets.',
    ].join('\n');
  }
}
