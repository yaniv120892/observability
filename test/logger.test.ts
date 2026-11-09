import { describe, expect, it } from 'vitest';
import { rawMessage } from '../src/error-message.js';
import { createLogger } from '../src/logger.js';
import { REDACTED } from '../src/redaction.js';
import { PrismaClientKnownRequestError, WITHHELD_PRISMA_MESSAGE } from './fakes/prisma-error.js';

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

  it('redacts secret keys by pattern, whatever their case or separators', () => {
    const { logger, lines } = capture();
    logger.warn(
      {
        refresh_token: 'a',
        headers: { 'X-Api-Key': 'b', Cookie: 'c' },
        member: { otpCode: '123456', inviteCode: 'd' },
        statusCode: 401,
        tokenCount: 12,
      },
      'upstream_refused',
    );
    expect(lines[0]).toMatchObject({
      refresh_token: REDACTED,
      headers: { 'X-Api-Key': REDACTED, Cookie: REDACTED },
      member: { otpCode: REDACTED, inviteCode: REDACTED },
      statusCode: 401,
      tokenCount: 12,
    });
  });

  it('logs a hash in place of an email, the same one for every line', () => {
    const { logger, lines } = capture();
    logger.info({ email: 'dana@example.com' }, 'signed_in');
    logger.child({ to: 'dana@example.com' }).info('invite_sent');
    expect(JSON.stringify(lines)).not.toContain('dana@example.com');
    expect(lines[0]?.email).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(lines[1]?.to).toBe(lines[0]?.email);
  });

  it("redacts a child's, a grandchild's and replaced bindings", () => {
    const { logger, lines } = capture();
    const child = logger.child({ sessionToken: 'a' });
    child.info('request_started');
    child.child({ apiKey: 'b' }).info('upstream_called');
    child.setBindings({ cookie: 'c' });
    child.info('bindings_replaced');
    expect(lines).toMatchObject([
      { sessionToken: REDACTED },
      { sessionToken: REDACTED, apiKey: REDACTED },
      { cookie: REDACTED },
    ]);
  });

  it("redacts a logged error's own fields, such as the headers of a failed request", () => {
    const { logger, lines } = capture();
    const error = Object.assign(new Error('Request failed with status code 401'), {
      config: { headers: { Authorization: 'Bearer plain', 'x-api-key': 'plain' } },
      email: 'dana@example.com',
    });
    logger.error({ err: error }, 'upstream_failed');
    logger.error(error);
    expect(JSON.stringify(lines)).not.toMatch(/plain|dana@example\.com/);
    expect(lines[0]).toMatchObject({
      err: {
        message: 'Request failed with status code 401',
        config: { headers: { Authorization: REDACTED, 'x-api-key': REDACTED } },
      },
    });
  });

  it('withholds a Prisma error message by default', () => {
    const { logger, lines } = capture();
    logger.error({ err: new PrismaClientKnownRequestError() }, 'insert_failed');
    logger.error(new PrismaClientKnownRequestError());
    expect(JSON.stringify(lines)).not.toContain('dana@example.com');
    expect(lines[0]).toMatchObject({ err: { message: WITHHELD_PRISMA_MESSAGE } });
    expect(lines[1]).toMatchObject({ msg: WITHHELD_PRISMA_MESSAGE });
  });

  it('keeps a Prisma error message when the app passes rawMessage', () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      service: 'my-app',
      level: 'info',
      errorMessage: rawMessage,
      destinations: [{ write: (line: string) => lines.push(JSON.parse(line)) }],
    });
    logger.error({ err: new PrismaClientKnownRequestError() }, 'insert_failed');
    expect(JSON.stringify(lines[0])).toContain('dana@example.com');
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
