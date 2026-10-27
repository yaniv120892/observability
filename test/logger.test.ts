import { describe, expect, it } from 'vitest';
import { createLogger, REDACTED } from '../src/logger.js';

function capture(secretKeys?: string[]) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'my-app',
    level: 'info',
    secretKeys,
    destinations: [{ write: (line: string) => lines.push(JSON.parse(line)) }],
  });
  return { logger, lines };
}

describe('createLogger', () => {
  it('labels the level and names the service', () => {
    const { logger, lines } = capture();
    logger.warn('slow_request');
    expect(lines[0]).toMatchObject({ level: 'warn', service: 'my-app', msg: 'slow_request' });
  });

  it('redacts default and app-specific secret keys up to three levels deep', () => {
    const { logger, lines } = capture(['setupCode']);
    logger.info(
      { token: 'a', nested: { authorization: 'b', deeper: { password: 'c' } }, setupCode: 'd' },
      'signed_in',
    );
    expect(lines[0]).toMatchObject({
      token: REDACTED,
      nested: { authorization: REDACTED, deeper: { password: REDACTED } },
      setupCode: REDACTED,
    });
  });

  it('redacts a capitalised Authorization header', () => {
    const { logger, lines } = capture();
    logger.error({ headers: { Authorization: 'Bearer secret' } }, 'upstream_failed');
    expect(lines[0]).toMatchObject({ headers: { Authorization: REDACTED } });
  });
});
