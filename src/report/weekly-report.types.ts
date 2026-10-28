export type Ranked = { name: string; count: number };

/** One app's last seven days, next to the seven before for comparison. */
export type AppWeek = {
  app: string;
  activeUsers: number;
  previousActiveUsers: number;
  newUsers: number;
  events: number;
  previousEvents: number;
  topUsers: Ranked[];
  topEvents: Ranked[];
};

export type HogQLRows = (string | number | boolean | null)[][];

export type PostHogQueryOptions = {
  apiHost: string;
  projectId: string;
  personalApiKey: string;
  fetchImplementation?: typeof fetch;
};
