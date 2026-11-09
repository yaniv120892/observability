/** Shaped like Prisma's own: its name marks it, and its message quotes the failing row. */
export class PrismaClientKnownRequestError extends Error {
  public readonly code = 'P2002';

  public constructor() {
    super('Unique constraint failed: Failing row contains (7, dana@example.com)');
    this.name = 'PrismaClientKnownRequestError';
  }
}

export const WITHHELD_PRISMA_MESSAGE = 'P2002; message withheld, it quotes query arguments';
