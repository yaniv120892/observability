import { vi } from 'vitest';

export type RecordedRequest = { url: string; init: RequestInit | undefined };

export function createRecordingFetch(status = 200) {
  const requests: RecordedRequest[] = [];
  const fetchImplementation = vi.fn(async function recordRequest(
    input: string | URL | Request,
    init?: RequestInit,
  ) {
    requests.push({ url: String(input), init });
    return new Response('', { status });
  });
  return { requests, fetchImplementation };
}

export function jsonBodyOf(request: RecordedRequest | undefined): unknown {
  if (typeof request?.init?.body !== 'string') {
    throw new Error(`Expected a string body, got ${typeof request?.init?.body}`);
  }
  return JSON.parse(request.init.body);
}
