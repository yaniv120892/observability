# observability

The logging, error tracking, uptime and alerting that my apps share, so a new app gets the same
stack as My Expenses by importing it:

- **Logs** — pino, JSON to stdout, and warn-and-above (plus any record marked `ship: true`) batched
  to a Better Stack HTTP source. Secrets are redacted by field name.
- **Errors** — Sentry, errors only, with request data collection pinned off and outgoing request
  breadcrumbs (`http`, `fetch`, `xhr`) cut to the URL's origin, method and status.
- **Uptime** — Better Stack heartbeats, plus liveness and deep-health route handlers for monitors.
- **Ops alerts** — Telegram messages to the owner, capped per alert type per hour, with a notice
  when the cap starts dropping alerts.

Every integration is inert until its variables are set, and nothing here throws into the code it
reports on.

## Install

```bash
npm install github:yaniv120892/observability#v0.1.5 pino
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

`initSentry` takes an optional `beforeBreadcrumb`, which runs after the package has already cut
request URLs down to their origin. A request breadcrumb reaches it without the SDK's `hint`, which
holds the raw request, so it never sees a path or query string. No query string is kept on any URL
Sentry collects.

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
at once when the buffer fills. Pass `shipLevel` to change where shipping starts.

## Serverless Node (Express on a function)

A function is frozen between invocations, so a timer never fires and a send nobody waits for is
lost. `mode: 'serverless'` starts no timer and ships from `warn` up by default; the app awaits
`flushRemoteLogs()` at the end of each invocation's work, and `waitUntil` keeps the function alive
for an error's immediate send and for the Sentry send of `reportError`. The `/node` entry loads
through `require()` from a CommonJS build (Node 22.12 and later), and nothing in it needs `next`.

```ts
import { waitUntil } from '@vercel/functions';
import { HEALTH_RESPONSE_HEADERS } from '@yaniv120892/observability';
import { createNodeObservability } from '@yaniv120892/observability/node';
import express from 'express';

const observabilityReady = createNodeObservability({
  service: 'my-agent',
  mode: 'serverless',
  waitUntil,
});

const app = express();

app.post('/jobs', async (request, response) => {
  const observability = await observabilityReady;
  response.status(202).json({ accepted: true });
  waitUntil(runJob({ observability, body: request.body }));
});

async function runJob({ observability, body }: RunJobInput): Promise<void> {
  try {
    await processJob(body);
  } catch (error) {
    observability.reportError({ error, where: 'job_failed' });
  } finally {
    await observability.flushRemoteLogs();
  }
}
```

Health routes come back as a status and a body, so any server can send them:

```ts
app.get('/api/health', async (_request, response) => {
  const { httpStatus, body } = (await observabilityReady).checkLiveness();
  response.status(httpStatus).set(HEALTH_RESPONSE_HEADERS).json(body);
});

const checkDeepHealth = observabilityReady.then((observability) =>
  observability.createDeepHealthCheck({ probes: { redis: () => redis.ping() } }),
);
app.get('/api/health/deep', async (_request, response) => {
  const { httpStatus, body } = await (await checkDeepHealth)();
  response.status(httpStatus).set(HEALTH_RESPONSE_HEADERS).json(body);
});
```

The same checks are exported from the root entry as `checkLiveness` and `createDeepHealthCheck`
(which takes a `logger`), for code that has no observability object.

## Withholding error messages

Some error messages quote the data that failed: a Prisma error quotes the query's arguments, and a
failed check constraint quotes the whole row. `errorMessage` rewrites an error's message, inside
its stack and its causes too, wherever the package sends it — the `err` field of every log line,
every Sentry event, and ops alerts. It defaults to the message unchanged.

```ts
import { withholdPrismaMessages } from '@yaniv120892/observability';

createNodeObservability({ service: 'my-worker', errorMessage: withholdPrismaMessages });
createNextObservability({ service: 'my-app', errorMessage: withholdPrismaMessages });
```

A Next app also passes it to `initSentry({ errorMessage: withholdPrismaMessages })` in
`instrumentation.ts`, so the events Sentry captures by itself are rewritten too; the Node entry
starts Sentry itself and covers them already. `createLogger` takes the same option. Only the
message is rewritten: other fields of the error, such as Prisma's `meta`, are logged as they are.

## Release

Bump `version` in the same PR as the change — Vercel caches a git dependency by version, so a
same-version change never reaches a deployed app. After the squash-merge, tag the merge commit:
`gh release create v<version> --generate-notes`.
