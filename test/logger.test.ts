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

  it('withholds an error message from the line, its stack and its causes', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      service: 'my-app',
      level: 'info',
      errorMessage: (error) => `${error.name}; message withheld`,
      destinations: [{ write: (line: string) => lines.push(JSON.parse(line)) }],
    });
    const cause = new TypeError('Failing row contains (7, dana@example.com)');
    logger.error({ err: new Error('dana@example.com', { cause }) }, 'insert_failed');
    expect(JSON.stringify(lines[0])).not.toContain('dana@example.com');
    expect(lines[0]).toMatchObject({
      err: {
        type: 'Error',
        message: 'Error; message withheld: TypeError; message withheld',
        stack: expect.stringContaining('caused by: TypeError: TypeError; message withheld'),
      },
    });
  });

  it('still logs, with the message withheld, when errorMessage throws', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      service: 'my-app',
      level: 'info',
      errorMessage: () => {
        throw new Error('rewrite failed');
      },
      destinations: [{ write: (line: string) => lines.push(JSON.parse(line)) }],
    });
    logger.error({ err: new Error('dana@example.com') }, 'insert_failed');
    expect(lines[0]).toMatchObject({ err: { message: 'message withheld, errorMessage threw' } });
  });

  it('withholds the message an error lends to msg when the line has none', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      service: 'my-app',
      level: 'info',
      errorMessage: (error) => `${error.name}; message withheld`,
      destinations: [{ write: (line: string) => lines.push(JSON.parse(line)) }],
    });
    logger.error(new Error('dana@example.com'));
    logger.error({ err: new Error('dana@example.com') });
    expect(lines.map((line) => line.msg)).toEqual([
      'Error; message withheld',
      'Error; message withheld',
    ]);
  });

  it('withholds a message changed after the error was built from the stack as well', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      service: 'my-app',
      level: 'info',
      errorMessage: () => 'message withheld',
      destinations: [{ write: (line: string) => lines.push(JSON.parse(line)) }],
    });
    const error = new Error('dana@example.com');
    expect(error.stack).toContain('Error: dana@example.com\n');
    error.message = `query failed: ${error.message}`;
    logger.error({ err: error }, 'query_failed');
    expect(JSON.stringify(lines[0])).not.toContain('dana@example.com');
  });

  it('logs an error whose getters need the original object, such as an abort', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      service: 'my-app',
      level: 'info',
      errorMessage: () => 'message withheld',
      destinations: [{ write: (line: string) => lines.push(JSON.parse(line)) }],
    });
    logger.error({ err: new DOMException('aborted at dana@example.com', 'AbortError') }, 'aborted');
    expect(lines[0]).toMatchObject({ err: { message: 'message withheld' } });
  });

  it('logs the raw message when no errorMessage is given', () => {
    const { logger, lines } = capture();
    logger.error({ err: new Error('Failing row contains (7)') }, 'insert_failed');
    expect(lines[0]).toMatchObject({ err: { message: 'Failing row contains (7)' } });
  });
});
