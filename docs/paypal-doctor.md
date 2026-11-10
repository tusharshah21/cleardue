# PayPal checks (doctor summary)

First run on 2026-11-09 on the `hardening-webinar` branch; the app-specific sections were re-run on 2026-11-10 after the project moved to a new sandbox app. No secrets or tokens appear here.

## How these checks were run

The brief asked for the PayPal AI Toolkit's `/paypal:doctor` (whole repo, then symptom mode for "webhooks not being received" and "invoice update rejected") and `/paypal:explain-error`. **That plugin was not installed in the Claude Code environment this work ran in, so none of its commands could be run, and nothing below is its output.** The same questions were answered by hand instead: by reading the code paths, and by running [scripts/paypal-checks.mts](../scripts/paypal-checks.mts) and [scripts/paypal-record.mts](../scripts/paypal-record.mts) against the sandbox. Re-running the real doctor once the plugin is installed is worth doing.

## Whole-repo review

| Area | Finding | Status |
| --- | --- | --- |
| Webhook route order | Duplicates were checked before the signature, and a failed sync returned 500 (inviting PayPal's 25 retries). | Fixed: verify, dedupe, store, answer 2xx, sync after the response; polling retries failed syncs. |
| Refunds | Polling skipped paid invoices, so a refund without a webhook was never seen. | Fixed: invoices paid in the last 180 days are re-read every 30 minutes. |
| Closed invoices | Only reminders and plans checked the invoice status; pauses, messages, cancels and recorded payments did not. | Fixed: one mandate rule denies every non-internal action on an invoice that isn't open. |
| Plan parts | A cancelled or refunded part left the plan looking active. | Fixed: the plan is marked interrupted and the freelancer is told on the original invoice. |
| Error logging | Errors carried `debug_id` but nothing logged it, and raw PayPal text reached the screen. | Fixed: one log line (status, name, issues, debug_id, never a body or token); plain sentences in the UI. |
| Token cache | Cached until 60 s before `expires_in`, one retry on 401. | Already correct; now covered by a test. |
| `simulate-event` helper | Sent `resource_version: "2.0"`, which the sandbox rejects for invoicing events with `400 VALIDATION_ERROR` "Not a valid Resource Type" (debug_id f244957bec3c8). | Fixed: the field is no longer sent. |
| Negative testing | `PayPal-Mock-Response` on an Invoicing API call returned a bare 403 with no error body, so the Invoicing API does not appear to support negative testing in this sandbox app. | Not fixable on our side; error handling is tested with recorded and mocked responses instead. |

## Symptom: "webhooks not being received"

- **After the move to a new sandbox app (2026-11-10):** a webhook belongs to one app, so the new app started with none. One was created for `https://cleardue-6laj.onrender.com/api/webhooks/paypal` with the four invoice events ClearDue handles (PAID, UPDATED, CANCELLED, REFUNDED), its id went into the local `.env` and the Render web service, and [scripts/paypal-app-check.mts](../scripts/paypal-app-check.mts) confirms the local id matches a registered webhook.
- Before the move, the sandbox app had one webhook, for the same URL, subscribed to the same four events. None missing.
- PayPal generated events for it today (the 03:01 UTC demo reset: CANCELLED and PAID), and the hosted invoice pages show those deliveries as **verified, processed**. So production receives and verifies webhooks.
- The hosted route answers an empty POST with 400, so it is up and refuses non-events.
- **Finding, now fixed:** the `PAYPAL_WEBHOOK_ID` in the local `.env` did not match the registered webhook, so a local server with a public tunnel would have rejected every delivery. The new app's webhook id is in the local `.env` and the check above passes.

## Symptom: "invoice update rejected"

- A full update (`PUT /v2/invoicing/invoices/{id}`) of a sandbox draft succeeded: the total went from 10.00 to 20.00 and the invoice number was kept. ClearDue only sends full updates to drafts.
- Updates that PayPal refuses on sent, paid or cancelled invoices now produce a plain message ("PayPal says this invoice can't be changed in its current state... press Sync") instead of the raw error.

## Real error hit during this work (explained by hand)

`422 UNPROCESSABLE_ENTITY`, issue `CANNOT_REMIND_INVOICE`, debug_id `f34268289bfd1`, from reminding a draft on purpose: "You cannot remind an invoice which is in DRAFT status. Only UNPAID, SENT and PARTIALLY_PAID invoices can be reminded."

- **Cause:** a reminder sent for an invoice that is not open. In ClearDue this can only happen if the local status is stale, because the mandate already denies reminders on invoices that aren't open.
- **Fix:** mapped to "PayPal only sends reminders for invoices that have been sent and are still unpaid. Press Sync to see the invoice's current state." (with the PayPal reference), and pinned by a test.

## Chosen not to fix

- Negative testing on the Invoicing API: not supported by this sandbox app, see above.
- Transaction Search: still `403 NOT_AUTHORIZED` on the new app (debug_id f6086178b2d96, 2026-11-10), and a fresh token has 29 scopes, none of them `reporting/search/read`, even though the feature is ticked in the app's settings. The code is built and tested ([src/paypal/transactions.ts](../src/paypal/transactions.ts)) but ships switched off (`LIVE_PAYPAL_PAYMENTS`, default off), so nobody sees an access warning. PayPal caches tokens for about 9 hours and community reports say a newly added permission can take that long, or need an app created with the box already ticked, to appear. Re-run `npx tsx scripts/paypal-app-check.mts`; when it prints `reporting/search/read scope present: YES`, set `LIVE_PAYPAL_PAYMENTS=true`.

## The new sandbox app: country and partial payments

- Creating a draft invoice with `configuration.partial_payment.allow_partial_payment` is refused: `400 INVALID_REQUEST`, "Partial payments are not available in your country." (debug_id f791506fd7d2e). So the business account behind this app is in India, Brazil or Israel (PayPal's API does not say which), and ClearDue's `split_invoices` strategy is the one that has to work. It does: a live seed against this app created the four demo stories, replaced the Northwind invoice with a 2-part split plan, and recorded both parts as paid.
- The plan logic picks the strategy from the freelancer's country in ClearDue's database (the demo freelancer is `IN`), so it matches this account. A freelancer whose ClearDue country says elsewhere but whose PayPal account is in one of those three countries would get the plain-English `PARTIAL_PAYMENT_NOT_ALLOWED` message rather than a silent failure.
- Draft invoices in USD, GBP and AUD (the demo's three currencies) are all accepted by this account.
