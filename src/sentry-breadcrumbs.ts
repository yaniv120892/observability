import type { BeforeBreadcrumb, UrlBearingBreadcrumb } from './sentry-breadcrumbs.types.js';

const REQUEST_CATEGORIES = new Set(['http', 'fetch', 'xhr']);

// Kept by name, so a URL-bearing key a later SDK adds (`url.full`, `url.query`) is dropped too.
const KEPT_REQUEST_DATA_KEYS = new Set([
  'method',
  'http.method',
  'http.request.method',
  'http.request_method',
  'status_code',
  'request_body_size',
  'response_body_size',
]);

const ABSOLUTE_URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;

/**
 * Runs the request-URL scrub before the app's own hook, so the app never sees, and cannot
 * re-emit, the path or query string.
 */
export function scrubRequestUrlsBefore<Breadcrumb extends UrlBearingBreadcrumb, Hint>(
  appBeforeBreadcrumb?: BeforeBreadcrumb<Breadcrumb, Hint>,
): BeforeBreadcrumb<Breadcrumb, Hint> {
  return function beforeBreadcrumb(breadcrumb, hint) {
    const scrubbed = scrubRequestUrls(breadcrumb);
    return appBeforeBreadcrumb ? appBeforeBreadcrumb(scrubbed, hint) : scrubbed;
  };
}

/**
 * An outgoing request's path names the object it touches (a storage key ends with the uploaded
 * file's name) and its query string can carry a presigned signature, so a request breadcrumb
 * keeps only the origin, method, status and sizes.
 */
export function scrubRequestUrls<Breadcrumb extends UrlBearingBreadcrumb>(
  breadcrumb: Breadcrumb,
): Breadcrumb {
  const isRequestBreadcrumb =
    breadcrumb.category !== undefined && REQUEST_CATEGORIES.has(breadcrumb.category);
  if (!isRequestBreadcrumb) {
    return breadcrumb;
  }
  const scrubbed = { ...breadcrumb };
  if (breadcrumb.data) {
    scrubbed.data = scrubRequestData(breadcrumb.data);
  }
  if (breadcrumb.message) {
    scrubbed.message = breadcrumb.message.replace(ABSOLUTE_URL_PATTERN, (url) => toOrigin(url));
  }
  return scrubbed;
}

function scrubRequestData(data: Record<string, unknown>): Record<string, unknown> {
  const kept = Object.entries(data).filter(([key]) => KEPT_REQUEST_DATA_KEYS.has(key));
  const scrubbed: Record<string, unknown> = Object.fromEntries(kept);
  if (typeof data.url === 'string') {
    scrubbed.url = toOrigin(data.url);
  }
  return scrubbed;
}

/** A relative URL is a same-origin browser request; one that does not parse is dropped whole. */
function toOrigin(url: string): string {
  try {
    return new URL(url, globalThis.location?.href).origin;
  } catch {
    return '[unparsable url]';
  }
}
