# observability

The logging, error tracking, uptime and alerting that my apps share, so a new app gets the same
stack as My Expenses by importing it:

- **Logs** — pino, JSON to stdout, and warn-and-above (plus any record marked `ship: true`) batched
  to a Better Stack HTTP source. Secrets are redacted by field name, and contact details hashed.
- **Errors** — Sentry, errors only, with request data collection pinned off and outgoing request
  breadcrumbs (`http`, `fetch`, `xhr`) cut to the URL's origin, method and status.
- **Uptime** — Better Stack heartbeats, plus liveness and deep-health route handlers for monitors.
- **Ops alerts** — Telegram messages to the owner, capped per alert type per hour, with a notice
  when the cap starts dropping alerts.
- **Product events** — server-side events to one shared PostHog project, and a weekly Telegram
  report built from them.

Every integration is inert until its variables are set, and nothing here throws into the code it
reports on.

## Install

```bash
npm install github:yaniv120892/observability#v0.3.0 pino
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
so Sentry still sees it. In both entries, `context` reaches Sentry as `extra`, redacted as the
logger redacts it. Its number and boolean values are also tags, next to the `where` tag, and so are
its strings under the keys in `DEFAULT_SENTRY_TAG_KEYS` (`method`, `route`, `status`, `model` and a
few more that name a kind of thing, not a person or a record). Pass `sentryTagKeys` to add keys; a
string id or an address stays out of tags, which Sentry indexes and keeps. A numeric id is still a
tag, as every number is.

## Redaction

Every log line (a logged error's own fields and child-logger bindings included), every `context`
sent to Sentry and every ops alert's context is walked three levels deep. A key is judged by its
words, whatever its case or separators: one that names a token, secret, password, authorization,
cookie, API key, private key, OTP, invite code, credential or connection string (`refreshToken`,
`x-api-key`, `OTP_CODE`, `passwordHash`, `DATABASE_URL`) is replaced by `[redacted]`, unless it holds
a boolean, while `statusCode`, `tokenCount` and `secretName` are kept. An `email` or a `phone`
(`userEmail`, `phoneNumber`), and a `to` that holds an email address or an international phone
number, become `sha256:` and 12 hex characters of the lower-cased value's hash, so one person's
lines still correlate. The hash is not keyed: anyone with a candidate address can confirm it, so it
keeps addresses out of plain sight, not out of reach. `secretKeys` adds exact names, matched in any
case. Redaction by name is a safety net, not a licence: log ids, not personal data.

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
`flushRemoteLogs()` at the end of each invocation's work (it ships product events too), and `waitUntil` keeps the function alive
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
failed check constraint quotes the whole row. `errorMessage` rewrites an error's message wherever
the package sends it: the `err` field and the `msg` it lends a line, the stack and causes, every
Sentry event's exception values and breadcrumbs, and ops alerts. It defaults to
`withholdPrismaMessages`, which keeps a Prisma error's code and withholds its message and leaves
every other message as it is; one that throws withholds the message outright. Pass `rawMessage` to
keep every message, or a function of the app's own:

```ts
import { createNodeObservability, rawMessage } from '@yaniv120892/observability/node';

createNodeObservability({ service: 'my-worker', errorMessage: rawMessage });
```

The Node entry starts Sentry itself, so that covers every event. In a Next app,
`createNextObservability({ service, errorMessage })` covers every server event sent once it has been
created; `initSentry({ errorMessage })` covers the ones before that and the browser's. Both take the
helpers from `@yaniv120892/observability/next/sentry`, which keeps pino out of the client bundle.
`createLogger` and `OpsAlerter` take the same option, with the same default. Only the message is rewritten: other fields of the error,
such as Prisma's `meta`, are logged as they are.

## Product events

Every app sends to the same PostHog project, because the free plan has one. Each event carries
`app` (the `service` name) and `environment`, and its person is `<service>:<userId>`, so ids from
two apps never merge and a dashboard filters by app.

```ts
observability.captureEvent({ event: 'expense_created', userId: user.id });
```

Send the app's own opaque user id and the name of the action, nothing else: no email, no name, no
amount. Name a page load `page_viewed` (or `web_ui_visited`), with the page as a property: the
weekly report counts it as a visit, and leaves it out of the action counts and the top users and
actions. Events are sent from the server only, so there is no client script and no cookie. In Next
they ship after the response; in a Node service, on the flush timer and on `shutdown()`, which also
sends what requests still finishing capture during that last send.
`POSTHOG_HOST` defaults to the US region, `https://us.i.posthog.com`; a project in the EU region
needs `https://eu.i.posthog.com`, or its events are rejected.

### Weekly report

`.github/workflows/weekly-report.yml` runs every Sunday at 09:00 Israel time and sends a dashboard
picture to Telegram, then a text message with the same numbers. Per app it shows active users, new
users, visits and actions against the week before, and the top actions; the text adds the top users.
If the picture cannot be drawn or sent, the text still goes out. A PostHog query that times out or hits a
server error is tried up to three times before the run fails. It counts `production` events only. It needs the
`POSTHOG_PROJECT_ID` repository variable (and `POSTHOG_API_HOST`, `https://eu.posthog.com`, for an
EU-region project; it defaults to `https://us.posthog.com`), a `POSTHOG_PERSONAL_API_KEY` secret (a personal key with
only the `query:read` scope), and the `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALERT_CHAT_ID` secrets.
Run it now from the Actions tab with **Run workflow**. GitHub turns a schedule off after 60 days
without a commit to the repository, so give it a Better Stack heartbeat with a period of a week and
put its URL in the optional `BETTERSTACK_HEARTBEAT_WEEKLY_REPORT` secret; a missed Sunday then
alerts.

Events are sent only from `production`, read from `VERCEL_ENV`, else `NODE_ENV`. A local run
(`NODE_ENV=development`, even with production variables pulled), a Vercel preview and a service
with neither variable set send nothing, so they spend no quota.

## Upgrading to 0.3.0

0.3.0 changes defaults that an app sees without touching its code:

- **Prisma error messages are withheld by default** in logs, Sentry events (server and browser) and
  ops alerts; only the error's code is kept. Pass `errorMessage: rawMessage` to
  `createNextObservability`, `initSentry` or `createNodeObservability` to get them back.
- **Redaction matches key patterns, not 11 exact names.** More keys are redacted (`x-api-key`,
  `otpCode`, `inviteCode`, any `…Token`), in any case, error fields, child-logger bindings and ops
  alert context included, and `email`, `phone` and address-holding `to` values are logged as a hash. A search for a raw address in the logs stops
  matching; search for its hash instead.
- **Sentry tags hold only numbers, booleans and allow-listed strings.** A string under any other
  key, such as `userId` or `importId`, is in the event's extra data but no longer a tag, so an
  issue search by that tag stops matching. Add the key to `sentryTagKeys` to keep it a tag.
- **A log flush waits at most about 3 seconds** and sends only what was buffered when it started;
  records written while it waits go with the next flush. `shutdown()` flushes up to five times, so
  a record logged during its last send still ships.
- **A shared alert counter gets 1 second** to answer before the alert is counted in the instance,
  logged as `ops_alert_counter_failed` like any other counter failure.
- **PostHog defaults to the US region**: an EU project must now set `POSTHOG_HOST` (events) and the
  `POSTHOG_API_HOST` repository variable (weekly report).

## Release

Bump `version` in the same PR as the change — Vercel caches a git dependency by version, so a
same-version change never reaches a deployed app. After the squash-merge, tag the merge commit:
`gh release create v<version> --generate-notes`.
