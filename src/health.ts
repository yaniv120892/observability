import type { Logger } from 'pino';
import type {
  DeepHealth,
  DeepHealthCheckOptions,
  LivenessHealth,
  ProbeStatus,
} from './health.types.js';

/** A monitor polling through a cache would see a stale outcome, so no response is stored. */
export const HEALTH_RESPONSE_HEADERS = { 'Cache-Control': 'no-store' } as const;

const DEFAULT_RESULT_TTL_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/** Liveness only: a dependency call here would keep a scale-to-zero database awake. */
export function checkLiveness(): LivenessHealth {
  return { httpStatus: 200, body: { status: 'ok' } };
}

/**
 * Framework-free: the returned check resolves to the status and body to send, so any server can
 * mount it. It never rejects.
 */
export function createDeepHealthCheck({
  probes,
  resultTtlMs = DEFAULT_RESULT_TTL_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  logger,
}: DeepHealthCheckOptions): () => Promise<DeepHealth> {
  let cached: { result: DeepHealth; expiresAt: number } | undefined;
  let inFlight: Promise<DeepHealth> | undefined;

  async function checkDependencies(): Promise<DeepHealth> {
    const entries = await Promise.all(
      Object.entries(probes).map(async ([name, run]) => {
        const status = await probe({ name, run, timeoutMs: probeTimeoutMs, logger });
        return [name, status] as const;
      }),
    );
    const checks = Object.fromEntries(entries);
    const healthy = entries.every(([, status]) => status === 'ok');
    const result: DeepHealth = {
      httpStatus: healthy ? 200 : 503,
      body: {
        status: healthy ? 'ok' : 'unhealthy',
        checks,
        checkedAt: new Date().toISOString(),
      },
    };
    cached = { result, expiresAt: Date.now() + resultTtlMs };
    return result;
  }

  async function checkOnce(): Promise<DeepHealth> {
    try {
      return await checkDependencies();
    } finally {
      inFlight = undefined;
    }
  }

  return async function deepHealthCheck() {
    if (cached && Date.now() < cached.expiresAt) {
      return cached.result;
    }
    inFlight ??= checkOnce();
    return inFlight;
  };
}

async function probe({
  name,
  run,
  timeoutMs,
  logger,
}: {
  name: string;
  run: () => Promise<unknown>;
  timeoutMs: number;
  logger: Logger;
}): Promise<ProbeStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([run(), timeout]);
    return 'ok';
  } catch (error) {
    logger.error({ err: error, check: name }, 'health_check_failed');
    return 'fail';
  } finally {
    clearTimeout(timer);
  }
}
