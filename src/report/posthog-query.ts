import type { HogQLCell, HogQLRows, PostHogQueryOptions } from './weekly-report.types.js';

const QUERY_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const TOO_MANY_REQUESTS = 429;
const FIRST_SERVER_ERROR = 500;

// The connection and retry settings plus the one HogQL statement to run.
type HogQLQueryRequest = PostHogQueryOptions & { query: string };

type FailedAttempt = { error: Error; isRetryable: boolean };

type QueryAttempt = { rows: HogQLRows } | FailedAttempt;

/**
 * PostHog answers a heavy query with a 504 now and then and the same query passes a minute later,
 * so a server error or a dropped connection is retried with a growing pause; a 4xx is not.
 */
export async function runHogQLQuery({
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  logger,
  ...options
}: HogQLQueryRequest): Promise<HogQLRows> {
  let attempt = 1;
  let outcome = await attemptQuery(options);
  while (isRetryableFailure(outcome) && attempt < MAX_ATTEMPTS) {
    logger?.warn({ attempt, err: outcome.error }, 'posthog_query_retrying');
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    attempt += 1;
    outcome = await attemptQuery(options);
  }
  if ('error' in outcome) {
    throw outcome.error;
  }
  return outcome.rows;
}

async function attemptQuery({
  query,
  apiHost,
  projectId,
  personalApiKey,
  fetchImplementation = fetch,
}: HogQLQueryRequest): Promise<QueryAttempt> {
  let payload: unknown;
  // The timeout also covers reading the body, so a read that is cut off is retried like a send.
  try {
    const response = await fetchImplementation(`${apiHost}/api/projects/${projectId}/query/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${personalApiKey}` },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      const isRetryable =
        response.status === TOO_MANY_REQUESTS || response.status >= FIRST_SERVER_ERROR;
      return {
        error: new Error(`PostHog query answered ${response.status}: ${detail}`),
        isRetryable,
      };
    }
    payload = await response.json();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      error: new Error(`PostHog query did not complete: ${reason}`, { cause: error }),
      isRetryable: true,
    };
  }
  return { rows: toRows(payload) };
}

function isRetryableFailure(outcome: QueryAttempt): outcome is FailedAttempt {
  return 'error' in outcome && outcome.isRetryable;
}

function toRows(body: unknown): HogQLRows {
  const hasResults = typeof body === 'object' && body !== null && 'results' in body;
  const results = hasResults ? body.results : null;
  if (!Array.isArray(results)) {
    throw new Error('PostHog query returned no results array');
  }
  return results.map((row: unknown) => {
    if (!Array.isArray(row)) {
      throw new Error('PostHog query returned a row that is not an array');
    }
    return row.map(toCell);
  });
}

function toCell(value: unknown): HogQLCell {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;
    default:
      return value === null ? null : JSON.stringify(value);
  }
}
