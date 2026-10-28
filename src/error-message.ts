import type { ErrorMessage, ExceptionEvent } from './error-message.types.js';

const PRISMA_ERROR_PREFIX = 'PrismaClient';

/** Copies already rewritten here, so a `beforeSend` that sees one does not rewrite it again. */
const withheldCopies = new WeakSet<Error>();

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
 * The app's rewrite of `error`'s message. A rewrite that throws must not fail the path that
 * reports, nor let the text it was meant to hide through, so the message is withheld outright.
 */
export function rewrittenMessage({
  error,
  errorMessage,
}: {
  error: Error;
  errorMessage: ErrorMessage;
}): string {
  try {
    return errorMessage(error);
  } catch {
    return `${error.name}; message withheld, errorMessage threw`;
  }
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
  const copies = new Map<Error, Error>();

  function withheldValue(value: unknown): unknown {
    return value instanceof Error ? withheldCopy(value) : value;
  }

  function withheldCopy(original: Error): Error {
    const existing = copies.get(original);
    if (existing) {
      return existing;
    }
    const copy: unknown = Object.create(
      Object.getPrototypeOf(original),
      Object.getOwnPropertyDescriptors(original),
    );
    if (!(copy instanceof Error)) {
      return original;
    }
    copies.set(original, copy);
    withheldCopies.add(copy);
    const replacement = {
      original: original.message,
      replacement: rewrittenMessage({ error: original, errorMessage }),
    };
    defineHidden({ target: copy, key: 'message', value: replacement.replacement });
    if (typeof original.stack === 'string') {
      defineHidden({
        target: copy,
        key: 'stack',
        value: replaceAll({ text: original.stack, replacements: [replacement] }),
      });
    }
    if (original.cause !== undefined) {
      defineHidden({ target: copy, key: 'cause', value: withheldValue(original.cause) });
    }
    if (original instanceof AggregateError && copy instanceof AggregateError) {
      copy.errors = original.errors.map(withheldValue);
    }
    return copy;
  }

  return withheldCopy(error);
}

/**
 * A Sentry `beforeSend` that rewrites the messages of every error event, including those the SDK
 * builds itself from an error the package never saw: an unhandled one, or one a framework
 * integration captured.
 */
export function withholdingBeforeSend(errorMessage: ErrorMessage) {
  return function beforeSend<Event extends ExceptionEvent>(
    event: Event,
    hint: { originalException?: unknown },
  ): Event {
    const replacements = linkedErrors(hint.originalException).map((error) => ({
      original: error.message,
      replacement: rewrittenMessage({ error, errorMessage }),
    }));
    for (const exception of event.exception?.values ?? []) {
      if (exception.value !== undefined) {
        exception.value = replaceAll({ text: exception.value, replacements });
      }
    }
    return event;
  };
}

type Replacement = { original: string; replacement: string };

/** As the runtime defines them: writable, but not enumerable, so a serializer does not repeat them. */
function defineHidden({ target, key, value }: { target: Error; key: string; value: unknown }) {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

/**
 * `error` and every error reachable through `cause` and `AggregateError.errors`, each once,
 * leaving out the copies this module already rewrote.
 */
function linkedErrors(error: unknown): Error[] {
  const found = new Set<Error>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const next = pending.pop();
    const isUnseenOriginal = next instanceof Error && !found.has(next) && !withheldCopies.has(next);
    if (isUnseenOriginal) {
      found.add(next);
      pending.push(next.cause, ...(next instanceof AggregateError ? next.errors : []));
    }
  }
  return [...found];
}

/** Longest first, so a message that contains another is replaced whole. */
function replaceAll({ text, replacements }: { text: string; replacements: Replacement[] }): string {
  return replacements
    .filter(({ original, replacement }) => original !== '' && original !== replacement)
    .toSorted((first, second) => second.original.length - first.original.length)
    .reduce((result, { original, replacement }) => result.replaceAll(original, replacement), text);
}
