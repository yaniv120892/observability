type UrlBearingBreadcrumb = {
  type?: string;
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
};

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

// Absolute or protocol-relative; trailing punctuation is left to the sentence around the URL.
const URL_PATTERN = /(?:\bhttps?:)?\/\/[^\s"'<>]*[^\s"'<>.,;:!?)\]]/gi;

/**
 * An outgoing request's path names the object it touches (a storage key ends with the uploaded
 * file's name) and its query string can carry a presigned signature, so a request breadcrumb
 * keeps only the origin, method, status and sizes.
 */
export function scrubRequestUrls<Breadcrumb extends UrlBearingBreadcrumb>(
  breadcrumb: Breadcrumb,
): Breadcrumb {
  if (!isRequestBreadcrumb(breadcrumb)) {
    return breadcrumb;
  }
  const { data, message } = breadcrumb;
  const scrubbed = { ...breadcrumb };
  if (data) {
    scrubbed.data = scrubRequestData(data);
  }
  if (message) {
    scrubbed.message = scrubMessage({ message, requestUrl: data?.url });
  }
  return scrubbed;
}

/** Judged by type as well as category, so a request recorded under a new category is caught. */
export function isRequestBreadcrumb(breadcrumb: UrlBearingBreadcrumb): boolean {
  return breadcrumb.type === 'http' || REQUEST_CATEGORIES.has(breadcrumb.category ?? '');
}

function scrubRequestData(data: Record<string, unknown>): Record<string, unknown> {
  const kept = Object.entries(data).filter(([key]) => KEPT_REQUEST_DATA_KEYS.has(key));
  const scrubbed: Record<string, unknown> = Object.fromEntries(kept);
  if (typeof data.url === 'string') {
    scrubbed.url = toOrigin(data.url);
  }
  return scrubbed;
}

/** The request's own URL is replaced even when it is a bare path, which the pattern misses. */
function scrubMessage({ message, requestUrl }: { message: string; requestUrl: unknown }): string {
  const withoutRequestUrl =
    typeof requestUrl === 'string' && requestUrl
      ? message.replaceAll(requestUrl, toOrigin(requestUrl))
      : message;
  return withoutRequestUrl.replace(URL_PATTERN, toOrigin);
}

/** A relative URL resolves against the page in a browser; elsewhere it has no origin to keep. */
function toOrigin(url: string): string {
  try {
    return new URL(url, globalThis.location?.href).origin;
  } catch {
    return '[url without origin]';
  }
}
