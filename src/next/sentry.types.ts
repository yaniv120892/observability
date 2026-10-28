import type * as Sentry from '@sentry/nextjs';
import type { ErrorMessage } from '../error-message.types.js';

export type NextBeforeBreadcrumb = NonNullable<Sentry.BrowserOptions['beforeBreadcrumb']>;

export type NextBeforeSend = NonNullable<Sentry.BrowserOptions['beforeSend']>;

export type NextSentryOptions = {
  /** Runs after the package has cut request URLs to their origin; see `initSentry`. */
  beforeBreadcrumb?: NextBeforeBreadcrumb;
  /** Rewrites the message of every error event the SDK sends, its own captures included. */
  errorMessage?: ErrorMessage;
};
