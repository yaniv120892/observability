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
});
