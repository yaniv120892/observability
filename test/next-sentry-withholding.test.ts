import * as Sentry from '@sentry/nextjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initSentry } from '../src/next/sentry.js';

vi.mock('next/server.js', () => ({ after: () => undefined }));

const { createNextObservability } = await import('../src/next/observability.js');

const lengthOnly = (error: Error) => `[${error.message.length} characters withheld]`;

let serviceIndex = 0;
let sentEvents: Sentry.Event[];

function exceptionValues() {
  return sentEvents.map((event) => event.exception?.values?.map(({ value }) => value));
}

function startSentry(options: Parameters<typeof initSentry>[0] = {}) {
  initSentry(options);
  Sentry.getClient()?.on('beforeSendEvent', (event) => {
    sentEvents.push(event);
  });
  serviceIndex += 1;
  return createNextObservability({
    service: `withholding-app-${serviceIndex}`,
    errorMessage: lengthOnly,
  });
}

beforeEach(() => {
  sentEvents = [];
  vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://key@sentry.example/1');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Sentry.close();
});

describe('createNextObservability with an errorMessage and the real Sentry SDK', () => {
  it("withholds the message from its own captures and the SDK's", async () => {
    const { reportError } = startSentry();
    reportError({ error: new Error('dana@example.com'), where: 'lookup_failed' });
    Sentry.captureException(new Error('Failing row contains (7)'));
    await vi.waitFor(() => expect(sentEvents).toHaveLength(2));
    expect(exceptionValues()).toHaveLength(2);
    expect(exceptionValues()).toEqual(
      expect.arrayContaining([['[16 characters withheld]'], ['[24 characters withheld]']]),
    );
  });

  it('rewrites once when initSentry is given the same function', async () => {
    const { reportError } = startSentry({ errorMessage: lengthOnly });
    reportError({ error: new Error('dana@example.com'), where: 'lookup_failed' });
    await vi.waitFor(() => expect(sentEvents).toHaveLength(1));
    expect(exceptionValues()).toEqual([['[16 characters withheld]']]);
  });

  it('reports an error once when the SDK sees it again after reportError', async () => {
    const { reportError } = startSentry();
    const error = new Error('dana@example.com');
    reportError({ error, where: 'lookup_failed' });
    Sentry.captureException(error);
    await vi.waitFor(() => expect(sentEvents).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sentEvents).toHaveLength(1);
  });
});
