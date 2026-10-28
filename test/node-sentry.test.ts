import * as Sentry from '@sentry/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeObservability } from '../src/node/observability.js';
import { createRecordingFetch } from './fakes/recording-fetch.js';

afterEach(async () => {
  await Sentry.close();
});

describe('createNodeObservability with Sentry on', () => {
  it('keeps only the origin of an outgoing request URL in its breadcrumb', async () => {
    const observability = await createNodeObservability({
      service: 'worker',
      environment: { SENTRY_DSN: 'https://key@sentry.example/1' },
      fetchImplementation: createRecordingFetch().fetchImplementation,
    });
    Sentry.getIsolationScope().clearBreadcrumbs();
    Sentry.addBreadcrumb({
      category: 'http',
      data: {
        url: 'https://api.example/members/7/documents/passport.pdf',
        'http.method': 'GET',
        'url.query': 'token=abc',
        status_code: 200,
      },
    });
    await observability.shutdown();
    expect(Sentry.getIsolationScope().getScopeData().breadcrumbs).toEqual([
      expect.objectContaining({
        data: { url: 'https://api.example', 'http.method': 'GET', status_code: 200 },
      }),
    ]);
  });

  it("withholds error messages from every event, the SDK's own captures included", async () => {
    const observability = await createNodeObservability({
      service: 'worker',
      environment: { SENTRY_DSN: 'https://key@sentry.example/1' },
      fetchImplementation: createRecordingFetch().fetchImplementation,
      errorMessage: (error) => `${error.name}; message withheld`,
    });
    const sentEvents: Sentry.Event[] = [];
    Sentry.getClient()?.on('beforeSendEvent', (event) => {
      sentEvents.push(event);
    });
    const cause = new TypeError('Failing row contains (7, dana@example.com)');
    Sentry.captureException(new Error('insert failed for dana@example.com', { cause }));
    observability.reportError({ error: new Error('dana@example.com'), where: 'lookup_failed' });
    await vi.waitFor(() => expect(sentEvents).toHaveLength(2));
    expect(sentEvents.map((event) => event.exception?.values?.map(({ value }) => value))).toEqual([
      ['TypeError; message withheld', 'Error; message withheld'],
      ['Error; message withheld'],
    ]);
    expect(JSON.stringify(sentEvents)).not.toContain('dana@example.com');
    await observability.shutdown();
  });
});
