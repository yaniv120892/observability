import { describe, expect, it } from 'vitest';
import {
  withholdErrorMessages,
  withholdingBeforeSend,
  withholdPrismaMessages,
} from '../src/error-message.js';

class PrismaClientKnownRequestError extends Error {
  public readonly code: string;

  public constructor({ message, code }: { message: string; code: string }) {
    super(message);
    this.name = 'PrismaClientKnownRequestError';
    this.code = code;
  }
}

describe('withholdPrismaMessages', () => {
  it('keeps the message of an ordinary error', () => {
    expect(withholdPrismaMessages(new Error('SMTP connection refused'))).toBe(
      'SMTP connection refused',
    );
  });

  it('keeps only the name and code of a Prisma error, which quotes query arguments', () => {
    const error = new PrismaClientKnownRequestError({
      message: 'Unique constraint failed: where: { email: "dana@example.com" }',
      code: 'P2002',
    });
    expect(withholdPrismaMessages(error)).toBe(
      'PrismaClientKnownRequestError (P2002); message withheld, it quotes query arguments',
    );
  });
});

describe('withholdErrorMessages', () => {
  const withheld = (error: Error) => `${error.name}; message withheld`;

  it('rewrites the message in a copy and leaves the thrown error alone', () => {
    const error = new PrismaClientKnownRequestError({
      message: 'Failing row contains (7, dana@example.com)',
      code: 'P2010',
    });
    const copy = withholdErrorMessages({ error, errorMessage: withheld });
    expect(copy).toBeInstanceOf(PrismaClientKnownRequestError);
    expect(copy).toMatchObject({ message: 'PrismaClientKnownRequestError; message withheld' });
    expect(copy.stack).not.toContain('dana@example.com');
    expect(copy.stack).toContain('test/error-message.test.ts');
    expect(error.message).toBe('Failing row contains (7, dana@example.com)');
  });

  it('rewrites causes and aggregated errors, and survives a cycle', () => {
    const inner = new Error('dana@example.com');
    const outer = new AggregateError([inner], 'batch failed for dana@example.com', {
      cause: inner,
    });
    inner.cause = outer;
    const copy = withholdErrorMessages({ error: outer, errorMessage: withheld });
    expect(copy).toBeInstanceOf(AggregateError);
    expect(copy.cause).toMatchObject({ message: 'Error; message withheld' });
    expect(copy instanceof AggregateError && copy.errors[0]).toBe(copy.cause);
    expect(copy.cause instanceof Error && copy.cause.cause).toBe(copy);
  });
});

describe('withholdingBeforeSend', () => {
  const prefixed = (error: Error) => `withheld(${error.name})`;

  function eventOf(...errors: Error[]) {
    return { exception: { values: errors.map((error) => ({ value: error.message })) } };
  }

  it('rewrites every aggregated error, not only the last one walked', () => {
    const first = new Error('first dana@example.com');
    const second = new Error('second dana@example.com');
    const aggregate = new AggregateError([first, second], 'batch failed');
    const event = withholdingBeforeSend(prefixed)(eventOf(first, second, aggregate), {
      originalException: aggregate,
    });
    expect(event.exception.values.map(({ value }) => value)).toEqual([
      'withheld(Error)',
      'withheld(Error)',
      'withheld(AggregateError)',
    ]);
  });

  it('leaves an error this package already rewrote as it is', () => {
    const lengthOnly = (error: Error) => `[${error.message.length} characters withheld]`;
    const copy = withholdErrorMessages({
      error: new Error('dana@example.com'),
      errorMessage: lengthOnly,
    });
    const event = withholdingBeforeSend(lengthOnly)(eventOf(copy), { originalException: copy });
    expect(event.exception.values.map(({ value }) => value)).toEqual(['[16 characters withheld]']);
  });

  it('withholds the whole message when errorMessage throws', () => {
    const error = new Error('dana@example.com');
    const event = withholdingBeforeSend(() => {
      throw new Error('rewrite failed');
    })(eventOf(error), { originalException: error });
    expect(event.exception.values.map(({ value }) => value)).toEqual([
      'Error; message withheld, errorMessage threw',
    ]);
  });
});
