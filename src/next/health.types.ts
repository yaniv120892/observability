import type { Logger } from 'pino';

export type ProbeStatus = 'ok' | 'fail';

export type DeepHealth = {
  httpStatus: number;
  body: {
    status: 'ok' | 'unhealthy';
    checks: Record<string, ProbeStatus>;
    checkedAt: string;
  };
};

export type DeepHealthOptions = {
  /** One async check per dependency; a rejection or a timeout marks it failed. */
  probes: Record<string, () => Promise<unknown>>;
  /**
   * Every probe can wake a scale-to-zero database, so within this window every call on the
   * instance gets the last outcome, failures included.
   */
  resultTtlMs?: number;
  /** A blackholed dependency never rejects; without a timeout the monitor gets a bodiless 504. */
  probeTimeoutMs?: number;
};

/** The deep-health options plus the logger a failed probe reports to. */
export type DeepHealthRouteOptions = DeepHealthOptions & { logger: Logger };
