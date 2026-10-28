import { describe, expect, it } from 'vitest';
import { loadObservabilityConfig } from '../src/config.js';

describe('loadObservabilityConfig', () => {
  it('logs at info when LOG_LEVEL is unset', () => {
    expect(loadObservabilityConfig({}).logLevel).toBe('info');
  });

  it('refuses a LOG_LEVEL pino does not know, naming the value', () => {
    expect(() => loadObservabilityConfig({ LOG_LEVEL: 'verbose' })).toThrow(/got "verbose"/);
    expect(() => loadObservabilityConfig({ LOG_LEVEL: 'toString' })).toThrow(/LOG_LEVEL/);
  });

  it('turns product analytics on with a PostHog key, in the EU region by default', () => {
    expect(loadObservabilityConfig({ NODE_ENV: 'production' }).productAnalytics).toBeNull();
    expect(
      loadObservabilityConfig({ NODE_ENV: 'production', POSTHOG_PROJECT_KEY: 'phc_x' })
        .productAnalytics,
    ).toEqual({
      projectKey: 'phc_x',
      host: 'https://eu.i.posthog.com',
    });
  });

  it('keeps product analytics off outside production, so only real traffic spends quota', () => {
    const withKey = { POSTHOG_PROJECT_KEY: 'phc_x' };
    expect(loadObservabilityConfig(withKey).productAnalytics).toBeNull();
    expect(
      loadObservabilityConfig({ ...withKey, NODE_ENV: 'production', VERCEL_ENV: 'preview' })
        .productAnalytics,
    ).toBeNull();
    expect(
      loadObservabilityConfig({ ...withKey, NODE_ENV: 'production', VERCEL_ENV: 'production' })
        .productAnalytics,
    ).not.toBeNull();
  });
});
