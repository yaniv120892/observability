import { describe, expect, it } from 'vitest';
import { withholdingEventProcessor, withholdPrismaMessages } from '../src/error-message.js';

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

  it('keeps only the code of a Prisma error, which quotes query arguments', () => {
    const error = new PrismaClientKnownRequestError({
      message: 'Unique constraint failed: where: { email: "dana@example.com" }',
      code: 'P2002',
    });
    expect(withholdPrismaMessages(error)).toBe(
      'P2002; message withheld, it quotes query arguments',
    );
  });
});

describe('withholdingEventProcessor', () => {
  const lengthOnly = (error: Error) => `[${error.message.length} characters withheld]`;

  function eventOf(...errors: Error[]) {
    return { exception: { values: errors.map((error) => ({ value: error.message })) } };
  }

  function valuesOf(event: { exception: { values: { value?: string }[] } }) {
    return event.exception.values.map(({ value }) => value);
  }

  it('rewrites every aggregated error, not only the last one walked', () => {
    const first = new Error('first dana@example.com');
    const second = new Error('second dana@example.com');
    const aggregate = new AggregateError([first, second], 'batch failed');
    const event = withholdingEventProcessor(lengthOnly)(eventOf(first, second, aggregate), {
      originalException: aggregate,
    });
    expect(valuesOf(event)).toEqual([
      '[22 characters withheld]',
      '[23 characters withheld]',
      '[12 characters withheld]',
    ]);
  });

  it('rewrites a breadcrumb that quotes the message', () => {
    const error = new Error('Failing row contains (7, dana@example.com)');
    const event = withholdingEventProcessor(lengthOnly)(
      { ...eventOf(error), breadcrumbs: [{ message: `prisma:error ${error.message}` }] },
      { originalException: error },
    );
    expect(event.breadcrumbs).toEqual([{ message: 'prisma:error [42 characters withheld]' }]);
  });

  it('withholds the whole message when errorMessage throws', () => {
    const error = new Error('dana@example.com');
    const event = withholdingEventProcessor(() => {
      throw new Error('rewrite failed');
    })(eventOf(error), { originalException: error });
    expect(valuesOf(event)).toEqual(['message withheld, errorMessage threw']);
  });
});
