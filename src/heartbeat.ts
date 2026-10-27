import type { Logger } from 'pino';

const PING_TIMEOUT_MS = 5000;

/**
 * Monitoring must never fail the run it monitors: every failure resolves. An unset URL warns, so
 * it reaches Better Stack — it otherwise looks exactly like a ping that never arrived.
 */
export async function pingHeartbeat({
  name,
  url,
  logger,
  fetchImplementation = fetch,
}: {
  name: string;
  url: string | undefined;
  logger: Logger;
  fetchImplementation?: typeof fetch;
}): Promise<void> {
  if (!url) {
    logger.warn({ heartbeat: name }, 'heartbeat_not_configured');
    return;
  }
  try {
    const response = await fetchImplementation(url, {
      method: 'POST',
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn({ heartbeat: name, status: response.status }, 'heartbeat_ping_rejected');
    }
  } catch (error) {
    logger.warn({ heartbeat: name, err: error }, 'heartbeat_ping_failed');
  }
}
