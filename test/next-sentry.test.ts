import * as Sentry from '@sentry/nextjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initSentry } from '../src/next/sentry.js';

const S3_DELETE_URL =
  'https://receipts.s3.eu-west-1.amazonaws.com/users/7/2026-10/receipt-ofek-pharmacy.pdf';

function recordedBreadcrumbs() {
  return Sentry.getIsolationScope().getScopeData().breadcrumbs;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://key@sentry.example/1');
  Sentry.getIsolationScope().clearBreadcrumbs();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Sentry.close();
});

describe('initSentry', () => {
  it('keeps only the origin of an outgoing request URL in its breadcrumb', () => {
    initSentry();
    Sentry.addBreadcrumb({
      category: 'http',
      type: 'http',
      data: {
        url: S3_DELETE_URL,
        'http.method': 'DELETE',
        'url.query': 'X-Amz-Signature=abc',
        'url.fragment': 'page=2',
        status_code: 204,
      },
    });
    expect(recordedBreadcrumbs()).toEqual([
      expect.objectContaining({
        category: 'http',
        data: {
          url: 'https://receipts.s3.eu-west-1.amazonaws.com',
          'http.method': 'DELETE',
          status_code: 204,
        },
      }),
    ]);
  });

  it("hands the app's beforeBreadcrumb the scrubbed breadcrumb and honours its drop", () => {
    const seenByApp: unknown[] = [];
    initSentry({
      beforeBreadcrumb(breadcrumb) {
        seenByApp.push(breadcrumb.data?.url);
        return breadcrumb.category === 'console' ? null : breadcrumb;
      },
    });
    Sentry.addBreadcrumb({ category: 'fetch', data: { url: S3_DELETE_URL, method: 'DELETE' } });
    Sentry.addBreadcrumb({ category: 'console', message: 'dropped by the app' });
    expect(seenByApp).toEqual(['https://receipts.s3.eu-west-1.amazonaws.com', undefined]);
    expect(recordedBreadcrumbs().map(({ category }) => category)).toEqual(['fetch']);
  });

  it('records no span even when an incoming trace header says the trace was sampled', () => {
    initSentry();
    const sampledTraceHeader = `${'a'.repeat(32)}-${'b'.repeat(16)}-1`;
    const isRecording = Sentry.continueTrace(
      { sentryTrace: sampledTraceHeader, baggage: undefined },
      () => Sentry.startSpan({ name: 'DELETE /api/receipts/[id]' }, (span) => span.isRecording()),
    );
    expect(isRecording).toBe(false);
  });
});
