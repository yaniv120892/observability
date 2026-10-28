import type { ErrorMessage, ExceptionEvent } from './error-message.types.js';

const PRISMA_ERROR_PREFIX = 'PrismaClient';

/**
 * An `errorMessage` for an app on Prisma: a Prisma error's message quotes the query's arguments,
 * and a failed check constraint quotes the whole failing row, so only its name and code are kept.
 */
export function withholdPrismaMessages(error: Error): string {
  if (!error.name.startsWith(PRISMA_ERROR_PREFIX)) {
    return error.message;
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : 'no code';
  return `${error.name} (${code}); message withheld, it quotes query arguments`;
}

/**
 * A copy of `error`, its causes and its aggregated errors, each with its message rewritten in
 * both `message` and `stack`. The original is left alone: the caller may still rethrow it.
 */
export function withholdErrorMessages({
  error,
  errorMessage,
}: {
  error: Error;
  errorMessage: ErrorMessage;
}): Error {
  return withheldCopy({ error, errorMessage, copies: new Map() });
}

/**
 * Rewrites the messages of a Sentry event built by the SDK itself, from an error the package
 * never saw: an unhandled one, or one captured by a framework integration.
 */
export function withholdEventMessages<Event extends ExceptionEvent>({
  event,
  originalException,
  errorMessage,
}: {
  event: Event;
  originalException: unknown;
  errorMessage: ErrorMessage;
}): Event {
  const replacements = messageReplacements({ error: originalException, errorMessage });
  for (const exception of event.exception?.values ?? []) {
    if (exception.value !== undefined) {
      exception.value = replaceAll({ text: exception.value, replacements });
    }
  }
  return event;
}

type Replacement = { original: string; replacement: string };

type CopyInput = { errorMessage: ErrorMessage; copies: Map<Error, Error> };

function withheldCopy({ error, errorMessage, copies }: CopyInput & { error: Error }): Error {
  const existing = copies.get(error);
  if (existing) {
    return existing;
  }
  const copy: unknown = Object.create(
    Object.getPrototypeOf(error),
    Object.getOwnPropertyDescriptors(error),
  );
  if (!(copy instanceof Error)) {
    return error;
  }
  copies.set(error, copy);
  const replacement = { original: error.message, replacement: errorMessage(error) };
  defineHidden({ target: copy, key: 'message', value: replacement.replacement });
  if (typeof error.stack === 'string') {
    defineHidden({
      target: copy,
      key: 'stack',
      value: replaceAll({ text: error.stack, replacements: [replacement] }),
    });
  }
  if (error.cause !== undefined) {
    defineHidden({
      target: copy,
      key: 'cause',
      value: withheldValue({ value: error.cause, errorMessage, copies }),
    });
  }
  if (error instanceof AggregateError && copy instanceof AggregateError) {
    copy.errors = error.errors.map((inner: unknown) =>
      withheldValue({ value: inner, errorMessage, copies }),
    );
  }
  return copy;
}

function withheldValue({ value, errorMessage, copies }: CopyInput & { value: unknown }): unknown {
  return value instanceof Error ? withheldCopy({ error: value, errorMessage, copies }) : value;
}

/** As the runtime defines them: writable, but not enumerable, so a serializer does not repeat them. */
function defineHidden({ target, key, value }: { target: Error; key: string; value: unknown }) {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function messageReplacements({
  error,
  errorMessage,
}: {
  error: unknown;
  errorMessage: ErrorMessage;
}): Replacement[] {
  const replacements: Replacement[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<Error>();
  let next = pending.pop();
  while (next !== undefined) {
    if (next instanceof Error && !seen.has(next)) {
      seen.add(next);
      replacements.push({ original: next.message, replacement: errorMessage(next) });
      pending.push(next.cause, ...(next instanceof AggregateError ? next.errors : []));
    }
    next = pending.pop();
  }
  return replacements;
}

/** Longest first, so a message that contains another is replaced whole. */
function replaceAll({ text, replacements }: { text: string; replacements: Replacement[] }): string {
  return replacements
    .filter(({ original, replacement }) => original !== '' && original !== replacement)
    .toSorted((first, second) => second.original.length - first.original.length)
    .reduce((result, { original, replacement }) => result.replaceAll(original, replacement), text);
}
