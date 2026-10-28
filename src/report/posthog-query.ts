import type { HogQLCell, HogQLRows, PostHogQueryOptions } from './weekly-report.types.js';

const QUERY_TIMEOUT_MS = 30_000;

export async function runHogQLQuery({
  query,
  apiHost,
  projectId,
  personalApiKey,
  fetchImplementation = fetch,
}: PostHogQueryOptions & { query: string }): Promise<HogQLRows> {
  const response = await fetchImplementation(`${apiHost}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${personalApiKey}` },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`PostHog query answered ${response.status}: ${detail}`);
  }
  return toRows(await response.json());
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
