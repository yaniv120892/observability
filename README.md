# observability

The logging, error tracking, uptime and alerting that my apps share, so a new app gets the same
stack as My Expenses by importing it:

- **Logs** — pino, JSON to stdout, and warn-and-above (plus any record marked `ship: true`) batched
  to a Better Stack HTTP source. Secrets are redacted by field name.
- **Errors** — Sentry, errors only, with request data collection pinned off.
- **Uptime** — Better Stack heartbeats, plus liveness and deep-health route handlers for monitors.
- **Ops alerts** — Telegram messages to the owner, capped per alert type per hour, with a notice
  when the cap starts dropping alerts.
- **Product events** — server-side events to one shared PostHog project, and a weekly Telegram
  report built from them.

Every integration is inert until its variables are set, and nothing here throws into the code it
reports on.

## Install

```bash
npm install github:yaniv120892/observability#v0.2.0 pino
```

A Next.js app also installs `@sentry/nextjs`, which the `/next` entry imports, and `pino-pretty`
for readable dev logs; a Node service installs `@sentry/node` if it reports to Sentry.

## Environment

| Variable                                              | Enables                   |
| ----------------------------------------------------- | ------------------------- |
| `BETTERSTACK_SOURCE_URL`, `BETTERSTACK_SOURCE_TOKEN`  | Log shipping              |
| `NEXT_PUBLIC_SENTRY_DSN` (Next) / `SENTRY_DSN` (Node) | Sentry                    |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALERT_CHAT_ID`        | Ops alerts                |
| `BETTERSTACK_HEARTBEAT_*` (any name you pass)         | Heartbeat pings           |
| `POSTHOG_PROJECT_KEY` (`phc_…`), `POSTHOG_HOST`       | Product events            |
| `LOG_LEVEL`                                           | Log level, default `info` |

## Next.js

`src/lib/observability.ts`:

```ts
import { createNextObservability } from '@yaniv120892/observability/next';

export const observability = createNextObservability({ service: 'my-app' });
export const { logger } = observability;
```

`src/instrumentation.ts` — the dynamic import keeps pino out of the Edge bundle:

```ts
import type { Instrumentation } from 'next';

export async function register(): Promise<void> {
  const { initSentry } = await import('@yaniv120892/observability/next/sentry');
  initSentry();
}

export const onRequestError: Instrumentation.onRequestError = async (...requestErrorArguments) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }
  const { observability } = await import('@/lib/observability');
  await observability.onRequestError(...requestErrorArguments);
};
```

`src/instrumentation-client.ts`:

```ts
import { initSentry } from '@yaniv120892/observability/next/sentry';

initSentry();
```

Health routes for the uptime monitors:

```ts
// src/app/api/health/route.ts
export const dynamic = 'force-dynamic';
export const GET = observability.healthRoute;

// src/app/api/health/deep/route.ts
export const dynamic = 'force-dynamic';
export const GET = observability.createDeepHealthRoute({
  probes: { db: () => prisma.$queryRaw`SELECT 1` },
});
```

A request that logs a warning flushes its batch from `after`; an error ships at once, and the same
hook keeps the function alive until it lands. A cron calls
`await observability.pingHeartbeat('BETTERSTACK_HEARTBEAT_SYNC')` when it succeeds, and a path that
catches an error and returns a fallback calls `observability.reportError({ error, where, context })`
so Sentry still sees it. In both entries, `context` reaches Sentry as `extra`, and its string,
number and boolean values also as tags, next to the `where` tag, with the logger's secret keys
redacted the same way.

Alerts are counted per serverless instance by default. An app with Redis caps them across
instances by passing `alertCounter`:

```ts
createNextObservability({
  service: 'my-app',
  alertCounter: ({ key, windowSeconds }) => incrementWithTtl(key, windowSeconds),
});
```

## Node service

```ts
import { createNodeObservability } from '@yaniv120892/observability/node';

const observability = await createNodeObservability({ service: 'my-worker' });
observability.reportError({ error, where: 'sync_failed', context: { memberId } });
await observability.notifyOpsAlert({ alertType: 'login', title: 'Login keeps failing' });
await observability.pingHeartbeat('BETTERSTACK_HEARTBEAT_SYNC');

process.once('SIGTERM', async () => {
  await observability.shutdown();
  process.exit(0);
});
```

A long-running process ships every record from `info` up, on a timer, at once for an error, and
at once when the buffer fills.

## Product events

Every app sends to the same PostHog project, because the free plan has one. Each event carries
`app` (the `service` name) and `environment`, and its person is `<service>:<userId>`, so ids from
two apps never merge and a dashboard filters by app.

```ts
observability.captureEvent({ event: 'expense_created', userId: user.id });
```

Send the app's own opaque user id and the name of the action, nothing else: no email, no name, no
amount. Events are sent from the server only, so there is no client script and no cookie. In Next
they ship after the response; in a Node service, on the flush timer and on `shutdown()`.
`POSTHOG_HOST` defaults to the EU region, `https://eu.i.posthog.com`.

### Weekly report

`.github/workflows/weekly-report.yml` runs every Sunday at 09:00 Israel time and sends one Telegram
message with, per app: active users, new users and actions against the week before, and the top
users and actions. Events from `development`, `preview` and `test` are left out. It needs the
`POSTHOG_PROJECT_ID` repository variable, a `POSTHOG_PERSONAL_API_KEY` secret (a personal key with
only the `query:read` scope), and the `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALERT_CHAT_ID` secrets.
Run it now from the Actions tab with **Run workflow**. GitHub turns a schedule off after 60 days
without a commit to the repository, so give it a Better Stack heartbeat with a period of a week and
put its URL in the optional `BETTERSTACK_HEARTBEAT_WEEKLY_REPORT` secret; a missed Sunday then
alerts.

A Node service sends events only when `NODE_ENV` (or `VERCEL_ENV`) names a real environment such
as `production`: unset, it counts as `development` and sends nothing.

## Release

Bump `version` in the same PR as the change — Vercel caches a git dependency by version, so a
same-version change never reaches a deployed app. After the squash-merge, tag the merge commit:
`gh release create v<version> --generate-notes`.
