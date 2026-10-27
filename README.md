# observability

The logging, error tracking, uptime and alerting that my apps share, so a new app gets the same
stack as My Expenses by importing it:

- **Logs** — pino, JSON to stdout, and warn-and-above (plus any record marked `ship: true`) batched
  to a Better Stack HTTP source. Secrets are redacted by field name.
- **Errors** — Sentry, errors only, with request data collection pinned off.
- **Uptime** — Better Stack heartbeats, plus liveness and deep-health route handlers for monitors.
- **Ops alerts** — Telegram messages to the owner, capped per alert type per hour, with a notice
  when the cap starts dropping alerts.

Every integration is inert until its variables are set, and nothing here throws into the code it
reports on.

## Install

```bash
npm install github:yaniv120892/observability#v0.1.0 pino
```

A Next.js app also installs `@sentry/nextjs` (and `pino-pretty` for readable dev logs); a Node
service installs `@sentry/node` if it reports to Sentry.

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

export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }
  const { observability } = await import('@/lib/observability');
  await observability.onRequestError(...args);
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

A request that logs a warning flushes its batch from `after`; an error ships at once. A cron calls
`await observability.pingHeartbeat('BETTERSTACK_HEARTBEAT_SYNC')` when it succeeds.

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
observability.reportError(error, { where: 'sync_failed', memberId });
await observability.alertOwner({ alertType: 'login', title: 'Login keeps failing' });
process.on('SIGTERM', () => void observability.shutdown());
```

A long-running process ships every record from `info` up, on a timer and at once for errors.

## Release

Bump `version` in the same PR as the change — Vercel caches a git dependency by version, so a
same-version change never reaches a deployed app. After the squash-merge, tag the merge commit:
`gh release create v<version> --generate-notes`.
