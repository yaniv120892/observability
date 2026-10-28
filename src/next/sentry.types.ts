import type * as Sentry from '@sentry/nextjs';

export type NextSentryOptions = {
  /** Runs after the package's own scrub of request URLs, on every breadcrumb. */
  beforeBreadcrumb?: (
    breadcrumb: Sentry.Breadcrumb,
    hint?: Sentry.BreadcrumbHint,
  ) => Sentry.Breadcrumb | null;
};
