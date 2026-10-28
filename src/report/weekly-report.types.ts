export type Ranked = { name: string; count: number };

/** One app's last seven days, next to the seven before for comparison. */
export type AppWeek = {
  app: string;
  activeUsers: number;
  previousActiveUsers: number;
  newUsers: number;
  actions: number;
  previousActions: number;
  visits: number;
  previousVisits: number;
  topUsers: Ranked[];
  topActions: Ranked[];
};

export type HogQLCell = string | number | boolean | null;

export type HogQLRows = HogQLCell[][];

export type PostHogQueryOptions = {
  apiHost: string;
  projectId: string;
  personalApiKey: string;
  fetchImplementation?: typeof fetch;
};
