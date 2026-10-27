export type OpsAlert = {
  /** What the hourly cap counts: an alert kind such as a method plus route pattern, never an id. */
  alertType: string;
  title: string;
  error?: unknown;
  context?: Record<string, string | number | null | undefined>;
};

/** Returns how many alerts of `key` were counted in the current window, this one included. */
export type AlertCounter = (countRequest: {
  key: string;
  windowSeconds: number;
}) => Promise<number>;
