export type AnalyticsPropertyValue = string | number | boolean | null;

export type AnalyticsEvent = {
  /** A past-tense action in snake_case, such as `expense_created`. Never carries a value. */
  event: string;
  /** The app's own opaque user id. Never an email, a name, or anything else that identifies. */
  userId: string;
  properties?: Record<string, AnalyticsPropertyValue>;
};

export type ProductAnalyticsConfig = {
  projectKey: string;
  host: string;
};
