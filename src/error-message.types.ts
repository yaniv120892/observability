/**
 * The text an error's message becomes wherever the package sends it: a log line, a Sentry event,
 * an ops alert. It also replaces the message inside the stack, which repeats it.
 */
export type ErrorMessage = (error: Error) => string;

/** The part of a Sentry event that carries error messages, in both the Next and Node SDKs. */
export type ExceptionEvent = {
  exception?: { values?: { value?: string }[] };
};
