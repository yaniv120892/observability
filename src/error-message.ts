import type { ErrorMessage, ExceptionEvent, SerializedErrorText } from './error-message.types.js';

type Replacement = { original: string; replacement: string };

const PRISMA_ERROR_PREFIX = 'PrismaClient';
const FIRST_STACK_FRAME = /\n\s+at /;

/**
 * An `errorMessage` for an app on Prisma: a Prisma error's message quotes the query's arguments,
 * and a failed check constraint quotes the whole failing row, so only its code is kept.
 */
export function withholdPrismaMessages(error: Error): string {
  if (!error.name.startsWith(PRISMA_ERROR_PREFIX)) {
    return error.message;
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : 'no code';
  return `${code}; message withheld, it quotes query arguments`;
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
    return 'message withheld, errorMessage threw';
  }
}

/**
 * Rewrites a serialized error's text in place, causes and aggregated errors included. The error
 * itself is never copied: a copy loses the internal slots some errors' getters read.
 */
export function withholdSerializedError<Serialized extends SerializedErrorText>({
  serialized,
  error,
  errorMessage,
}: {
  serialized: Serialized;
  error: Error;
  errorMessage: ErrorMessage;
}): Serialized {
  const replacements = replacementsFor({ error, errorMessage });
  rewriteSerialized({ serialized, replacements });
  return serialized;
}

/**
 * A Sentry event processor, usable as `beforeSend`, that rewrites the messages of every error
 * event, including those the SDK builds itself from an error the package never saw, and the
 * breadcrumbs that quote them.
 */
export function withholdingEventProcessor(errorMessage: ErrorMessage) {
  return function withholdEventMessages<Event extends ExceptionEvent>(
    event: Event,
    hint: { originalException?: unknown },
  ): Event {
    const replacements = replacementsFor({ error: hint.originalException, errorMessage });
    for (const exception of event.exception?.values ?? []) {
      if (exception.value !== undefined) {
        exception.value = replaceAll({ text: exception.value, replacements });
      }
    }
    for (const breadcrumb of event.breadcrumbs ?? []) {
      if (breadcrumb.message !== undefined) {
        breadcrumb.message = replaceAll({ text: breadcrumb.message, replacements });
      }
    }
    return event;
  };
}

/**
 * For each linked error, its message and its stack's header line. The header is replaced whole,
 * so a message changed after the error was built, which the header no longer matches, is still
 * withheld from the stack.
 */
function replacementsFor({
  error,
  errorMessage,
}: {
  error: unknown;
  errorMessage: ErrorMessage;
}): Replacement[] {
  return linkedErrors(error)
    .flatMap((linked) => {
      const replacement = rewrittenMessage({ error: linked, errorMessage });
      const header = stackHeader(linked);
      return [
        { original: linked.message, replacement },
        ...(header === null
          ? []
          : [{ original: header, replacement: `${linked.name}: ${replacement}` }]),
      ];
    })
    .filter(({ original, replacement }) => original !== '' && original !== replacement)
    .toSorted((first, second) => second.original.length - first.original.length);
}

function stackHeader(error: Error): string | null {
  if (typeof error.stack !== 'string') {
    return null;
  }
  const firstFrame = FIRST_STACK_FRAME.exec(error.stack);
  return firstFrame ? error.stack.slice(0, firstFrame.index) : error.stack;
}

function rewriteSerialized({
  serialized,
  replacements,
}: {
  serialized: SerializedErrorText;
  replacements: Replacement[];
}): void {
  serialized.message = replaceAll({ text: serialized.message, replacements });
  serialized.stack = replaceAll({ text: serialized.stack, replacements });
  for (const aggregated of serialized.aggregateErrors ?? []) {
    rewriteSerialized({ serialized: aggregated, replacements });
  }
}

/** `error` and every error reachable through `cause` and `AggregateError.errors`, each once. */
function linkedErrors(error: unknown): Error[] {
  const found = new Set<Error>();
  const pending: unknown[] = [error];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next instanceof Error && !found.has(next)) {
      found.add(next);
      pending.push(next.cause, ...(next instanceof AggregateError ? next.errors : []));
    }
  }
  return [...found];
}

/** Replacements arrive longest first, so a text that contains another is replaced whole. */
function replaceAll({ text, replacements }: { text: string; replacements: Replacement[] }): string {
  return replacements.reduce(
    (result, { original, replacement }) => result.replaceAll(original, replacement),
    text,
  );
}
