import { describe, expect, it } from 'vitest';
import { withholdErrorMessages, withholdPrismaMessages } from '../src/error-message.js';

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
