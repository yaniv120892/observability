import type * as Sentry from '@sentry/nextjs';

export type NextBeforeBreadcrumb = NonNullable<Sentry.BrowserOptions['beforeBreadcrumb']>;

export type NextSentryOptions = {
  /** Runs after the package has cut request URLs to their origin; see `initSentry`. */
  beforeBreadcrumb?: NextBeforeBreadcrumb;
};
