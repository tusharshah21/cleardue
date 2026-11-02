# ClearDue

An AI collections agent for solo freelancers who bill overseas clients through PayPal. ClearDue works out *why* a client hasn't paid (forgot, waiting on approval, short on cash, disputing the work, wrong contact) and takes the matching action, always inside limits the freelancer sets. Clients get an assistant on the pay page that answers questions from the agreed scope.

> Status: Milestone 3 (pay page, scope check, payment plans). The full README (architecture, PayPal and AI usage, evals, limitations) lands in Milestone 4.

## Payment plans and the India constraint

PayPal doesn't allow partial payments on invoices from merchants in India, Brazil or Israel. ClearDue picks a plan strategy from the freelancer's country, behind one pipeline (`src/plans`):

- `split_invoices` (IN, BR, IL): the original invoice is replaced by one PayPal invoice per instalment.
- `partial_payment` (everyone else): one replacement invoice that accepts part payments, with the first instalment as the minimum.

Either way the client always has something payable: the new drafts are created first, the original is re-read and only cancelled if it is still unpaid (silently, `send_to_recipient=false`), then the drafts are sent. If a send fails after the cancel, the plan stays `pending_send` and polling retries it.

## Stack

Next.js 16 (App Router) · TypeScript (strict) · Tailwind CSS 4 · shadcn/ui · Prisma 7 + Postgres · Zod · Vitest · PayPal REST APIs (sandbox only) · Render.

## Local setup

Requirements: Node 24, Docker.

```bash
npm install
cp .env.example .env          # then fill in the PayPal values (see below)
docker compose up -d          # Postgres on localhost:5433
npx prisma migrate dev
npm run seed                  # demo data, no PayPal calls
npm run dev                   # http://localhost:3000
```

Sign in with `DEMO_EMAIL` / `DEMO_PASSWORD` from `.env`.

To seed with real sandbox invoices instead (each demo invoice is created and sent through PayPal):

```bash
npm run seed:paypal
```

## PayPal sandbox setup

ClearDue only ever talks to `https://api-m.sandbox.paypal.com`; the client refuses any other host.

1. Sign in at [developer.paypal.com](https://developer.paypal.com) and open **Testing Tools > Sandbox Accounts**.
2. Create a **Business** account: this is the freelancer (the invoicer). Pick **India** as the country to match the demo story.
3. Create a **Personal** account: this is the client who pays. Put its email in `SEED_CLIENT_EMAIL` (and `SPIKE_PAYER_EMAIL`).
4. Under **Apps & Credentials** (Sandbox tab), create an app linked to the Business account. Copy its Client ID and Secret into `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.
5. Sandbox emails (invoices, reminders) don't reach real inboxes. View them under **Testing Tools > Sandbox Notifications** (or the sandbox account's notifications page).

Check the account works end to end:

```bash
npm run paypal:spike
```

It creates, sends, reminds and silently cancels a USD invoice, tests whether `partial_payment` is allowed for this account, and writes the results to `docs/progress/paypal-spike.json`.

## Webhooks and polling

Create the webhook once your app has a public URL (Render, or a tunnel locally):

```bash
npm run paypal:webhook -- create https://<your-app>/api/webhooks/paypal
```

Put the printed id in `PAYPAL_WEBHOOK_ID`. It subscribes `INVOICING.INVOICE.PAID`, `UPDATED`, `CANCELLED` and `REFUNDED`. Every event is checked with PayPal's verify-webhook-signature endpoint and stored in the `WebhookEvent` table (idempotent by event id). The payload is never trusted for state: ClearDue re-reads the invoice from PayPal.

PayPal's webhook simulator sends mock events that [cannot pass verify-webhook-signature](https://developer.paypal.com/api/rest/webhooks/simulator/). They are rejected (and labelled) unless `ALLOW_UNVERIFIED_WEBHOOKS=true` outside production. Real sandbox payments produce verifiable events.

Because webhooks can be late or missing, `POST /api/sync` (bearer `CRON_SECRET`) re-syncs open invoices and ends expired pauses. The Render blueprint runs it every 5 minutes as a cron job, and the dashboard also triggers it after each load.

## Environment variables

See [.env.example](.env.example). Never commit `.env`.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (local Docker or Neon) |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox REST app credentials |
| `PAYPAL_BASE_URL` | Must be `https://api-m.sandbox.paypal.com` |
| `PAYPAL_WEBHOOK_ID` | Webhook ID used by verify-webhook-signature |
| `ALLOW_UNVERIFIED_WEBHOOKS` | Dev only: process events that fail verification (PayPal's simulator). Ignored when `NODE_ENV=production` |
| `ANTHROPIC_API_KEY`, `AI_MODEL` | Claude access; the model name is read from env |
| `DEMO_MODE` | `true` replays recorded AI responses for the seeded stories (Acme diagnosis and scope check, Brightside plan, Koala's pay-page question); other prompts go to the live model |
| `DEMO_EMAIL`, `DEMO_PASSWORD`, `SESSION_PASSWORD` | Single demo login; session secret needs 32+ chars |
| `APP_URL` | Public base URL for client pay-page links |
| `CRON_SECRET` | Protects the polling sync endpoint |
| `SEED_CLIENT_EMAIL`, `SEED_AP_EMAIL` | Sandbox personal account and AP inbox used by the seed |

## Deploy (Render + Neon)

1. Create a Neon Postgres database and copy its connection string.
2. In Render, create a Blueprint from this repo; it picks up [render.yaml](render.yaml) (Starter web service).
3. Set `DATABASE_URL` and the other `sync: false` variables in the Render dashboard. Migrations run in the pre-deploy step.
4. Seed once from your machine against Neon: `DATABASE_URL=<neon url> npm run seed`.

## Tests

```bash
npm test
npm run typecheck
```

## License

[MIT](LICENSE)
