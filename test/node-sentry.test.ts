import * as Sentry from '@sentry/node';
import { afterEach, describe, expect, it } from 'vitest';
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
});
