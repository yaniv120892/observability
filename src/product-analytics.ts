import type { Logger } from 'pino';
import type {
  AnalyticsEvent,
  AnalyticsPropertyValue,
  ProductAnalyticsConfig,
} from './product-analytics.types.js';

type ProductAnalyticsOptions = {
  service: string;
  environment: string;
  config: ProductAnalyticsConfig | null;
  logger: Logger;
  fetchImplementation?: typeof fetch;
};

type PendingEvent = {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Record<string, AnalyticsPropertyValue>;
};

const MAX_BUFFERED_EVENTS = 200;
const SEND_TIMEOUT_MS = 3000;

/**
 * Sends product events to PostHog's batch API, without its SDK. One PostHog project serves every
 * app, so each event carries `app`, and the person is `<app>:<userId>` so ids from two apps never
 * merge. It is inert without a key, never throws, and drops the oldest events past its cap rather
 * than grow; whoever owns it decides when to flush.
 */
export class ProductAnalytics {
  private readonly service: string;
  private readonly environment: string;
  private readonly config: ProductAnalyticsConfig | null;
  private readonly logger: Logger;
  private readonly fetchImplementation: typeof fetch;
  private buffer: PendingEvent[] = [];
  private isFailureReported = false;

  public constructor(options: ProductAnalyticsOptions) {
    this.service = options.service;
    this.environment = options.environment;
    this.config = options.config;
    this.logger = options.logger;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public get isEnabled(): boolean {
    return this.config !== null;
  }

  public capture({ event, userId, properties = {} }: AnalyticsEvent): void {
    if (!this.config) {
      return;
    }
    if (this.buffer.length >= MAX_BUFFERED_EVENTS) {
      this.buffer.shift();
    }
    this.buffer.push({
      event,
      distinct_id: `${this.service}:${userId}`,
      timestamp: new Date().toISOString(),
      properties: { ...properties, app: this.service, environment: this.environment },
    });
  }

  public async flush(): Promise<void> {
    if (!this.config || this.buffer.length === 0) {
      return;
    }
    const batch = this.buffer;
    this.buffer = [];
    try {
      const response = await this.fetchImplementation(`${this.config.host}/batch/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: this.config.projectKey, batch }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.reportFailure({ status: response.status, events: batch.length });
        return;
      }
      this.isFailureReported = false;
    } catch (error) {
      this.reportFailure({ error, events: batch.length });
    }
  }

  // Once per run of failures: analytics is never worth a warning on every flush.
  private reportFailure(details: { status?: number; error?: unknown; events: number }): void {
    if (this.isFailureReported) {
      return;
    }
    this.isFailureReported = true;
    this.logger.warn(
      { status: details.status, err: details.error, droppedEvents: details.events },
      'product_analytics_send_failed',
    );
  }
}
