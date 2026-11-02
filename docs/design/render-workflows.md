# Design: background work on Render Workflows

Status: proposal, not built. Goal: qualify for Render's prize (deploy on Render and use Render Workflows for agents or background jobs) without making the demo depend on a beta product.

## What Render Workflows gives us

From [render.com/docs/workflows](https://render.com/docs/workflows), the [TypeScript SDK reference](https://render.com/docs/workflows-sdk-typescript) and the [launch post](https://render.com/blog/durability-as-code-introducing-render-workflows):

- A **workflow service** is a separate Render service built from the same repo. Tasks are plain async functions wrapped with `task({ name, retry, timeoutSeconds, plan }, fn)` from `@renderinc/sdk/workflows`. Every task function gets a `TaskContext` first.
- Each **task run gets its own instance**, billed per second of compute (the default `flex` plan suits short jobs). Runs last up to 24 hours (default timeout 2 hours). Runs beyond the compute limits are queued, not dropped.
- **Retries are built in**: `retry: { maxRetries, waitDurationMs, backoffScaling }`, and the default is 2 retries.
- **Subtasks**: a task can call another task (`ctx.run`), and each subtask runs on its own instance. That's our fan-out.
- **Triggering** from app code: `new Render()` (reads `RENDER_API_KEY`), then `render.workflows.startTask("cleardue/syncAll", [args])` (fire and forget, `.get()` to wait) or `runTask` (wait for the result). Runs also show up in the Render dashboard, which is useful for the prize video.
- **No built-in cron yet**: Render's docs say to trigger scheduled tasks from a cron job. We already have one.
- Tasks can reach Postgres and use env vars like any service. Neon is reached over the internet, as the web service does today.
- **Beta**: the SDK is marked beta and may change.

## What moves, and what stays

| Work | Today | With Workflows |
| --- | --- | --- |
| Poll PayPal for open invoices, end expired pauses | `POST /api/sync` (cron every 5 min) runs `syncStale()` inline, up to 50 invoices in one request | Cron still calls `/api/sync`, which now starts `syncAll`. `syncAll` lists stale open invoices and fans out one `syncInvoice` subtask each, so one slow PayPal call can't time out the whole batch |
| Retry plan invoices stuck in `pending_send` | `retryPendingPlans()` inside `/api/sync` and on dashboard loads | A `sendPlan(groupId)` task, started **immediately** when `executePlan` ends in `pending_send`, with retries and backoff (for example 5 tries, 30 s doubling). The `syncAll` sweep still picks up any group left behind |
| Diagnosis after a new client reply | Only when the freelancer clicks **Diagnose now** | A `diagnose(invoiceId)` task, started when a client reply is saved (pasted reply today, inbound email later) and by a daily sweep of overdue invoices. This is the "agent runs in the background" part: autopilot clients get their PayPal reminder without anyone opening the app |
| Interactive **Diagnose now** with live stages | NDJSON stream from the web service | **Stays in-process.** It's the key demo scene and needs live progress; a workflow run would turn it into polling. Same function, so behaviour is identical |
| Webhook handling | Inline in the route | Stays inline. It's fast, and PayPal wants a quick 200 |

All three tasks call the existing functions (`syncInvoice`, `sendPending`, `analyzeInvoice`), so the mandate gate, grounding guards and timeline are unchanged. Workflows only changes *where* and *when* the code runs.

## One dispatch point, with a built-in fallback

A single helper decides where work runs:

```ts
// src/lib/dispatch.ts (sketch)
export async function dispatch(task: "syncAll" | "sendPlan" | "diagnose", args: unknown[], inline: () => Promise<unknown>) {
  if (process.env.WORKFLOWS_ENABLED === "true" && !isMockMode()) {
    try {
      await render.workflows.startTask(`${process.env.WORKFLOW_SLUG}/${task}`, args);
      return { via: "workflow" };
    } catch (e) {
      console.error(`workflow ${task} failed to start, running inline`, e);
    }
  }
  return { via: "inline", result: await inline() };
}
```

- **Cron fallback comes for free.** The cron job keeps calling `/api/sync`. With Workflows on, `/api/sync` starts `syncAll` and returns at once. With Workflows off, or if starting the run fails (API down, bad key), it runs today's inline code. One cron, no second schedule to keep in step.
- **Mock mode always runs inline.** The mock PayPal store is a file on the web instance, and a workflow run on another instance can't see it. So `PAYPAL_MODE=mock` (local dev and the early deploy check) never uses Workflows.
- `WORKFLOWS_ENABLED` defaults to off. Local dev and tests are unaffected.

## Making retries safe

Workflows retries failed tasks, so every task must be safe to run twice:

- `syncInvoice` re-reads PayPal and writes the result, so it's naturally idempotent.
- `sendPending` only sends invoices still in DRAFT, so a retry after a partial success sends only what's left.
- `diagnose` is the risky one: a second run would add duplicate proposals, and on autopilot it could **send a second PayPal reminder**. Guard it in the database, not in the workflow:
  - Store `Case.diagnosedThroughMessageId`, the newest client message the last diagnosis saw. The task exits early if there's no newer client message (the button can still force a re-run).
  - Take a Postgres advisory lock on the invoice id for the whole run, so a button click and a background run can't overlap.
  - Set `retry: { maxRetries: 1 }` for `diagnose`, and only retry failures that happen before any action is recorded. The AI call already has a 20 s cap and a fallback, so a retry mostly covers database or network errors.

## Deploy shape

- New workflow service `cleardue-workflows`, same repo, entry file `workflows/index.ts`. It imports the tasks, which import from `src/`. Build: `npm ci && npx prisma generate`. Start: run the entry with `tsx --conditions=react-server`. I checked that this flag lets our `server-only` imports load outside Next.js.
- Env on the workflow service: `DATABASE_URL`, `PAYPAL_*`, `ANTHROPIC_API_KEY`, `AI_MODEL`, `APP_URL`.
- Env on the web service: `WORKFLOWS_ENABLED`, `WORKFLOW_SLUG`, `RENDER_API_KEY`. The API key can start runs on our account, so it's server-only and never logged.
- `render.yaml`: Render's overview says Blueprints can list workflow services, but a community guide says they can't yet. If they can't, I create the workflow service in the dashboard and document it in the README. Either way the web service and cron stay in the Blueprint.

## Effort and risk

- About 1 to 1.5 days:
  - Half a day for the tasks, the dispatch helper and the diagnose guard (with a migration).
  - Half a day for the workflow service deploy and env.
  - A few hours for tests: dispatch fallback, the idempotent diagnose guard, and `sendPlan` after a partial send. Plus a README section and a short "runs in the Render dashboard" beat for the video.
- Risks:
  - The SDK is in beta. The fallback keeps the app working if Workflows misbehaves.
  - Cold-start latency per run. It doesn't matter for background work, which is why interactive diagnosis stays inline.
  - The workflow service needs real sandbox credentials, so it can only be tested end to end once `.env` has them.

## Order of work, once approved

1. Add the dispatch helper and the diagnose guard, with tests. Workflows stays off.
2. Add the workflow entry and the three tasks, and run them locally with Render's local dev tooling.
3. Deploy the workflow service, turn on `WORKFLOWS_ENABLED` on Render, and check that runs appear in the dashboard and invoices sync.
4. Add the README section and a demo beat.
