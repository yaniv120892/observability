/** The breadcrumb fields the URL scrub reads, shared by the Node, Next and browser SDKs. */
export type UrlBearingBreadcrumb = {
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
};

export type BeforeBreadcrumb<Breadcrumb, Hint> = (
  breadcrumb: Breadcrumb,
  hint?: Hint,
) => Breadcrumb | null;
