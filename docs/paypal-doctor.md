# PayPal checks (doctor summary)

Run on 2026-11-09 on the `hardening-webinar` branch. No secrets, tokens or webhook ids appear here.

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

- The sandbox app has one webhook, for `https://cleardue-6laj.onrender.com/api/webhooks/paypal`, subscribed to all four invoice events (PAID, UPDATED, CANCELLED, REFUNDED). None missing.
- PayPal generated events for it today (the 03:01 UTC demo reset: CANCELLED and PAID), and the hosted invoice pages show those deliveries as **verified, processed**. So production receives and verifies webhooks.
- The hosted route answers an empty POST with 400, so it is up and refuses non-events.
- **Finding, not fixed:** the `PAYPAL_WEBHOOK_ID` in the local `.env` does not match the registered webhook. Production is unaffected (Render has the right id, as the verified deliveries show), but a local server with a public tunnel would reject every delivery. Fix by copying the id from the developer dashboard into the local `.env`; this work does not edit secrets.

## Symptom: "invoice update rejected"

- A full update (`PUT /v2/invoicing/invoices/{id}`) of a sandbox draft succeeded: the total went from 10.00 to 20.00 and the invoice number was kept. ClearDue only sends full updates to drafts.
- Updates that PayPal refuses on sent, paid or cancelled invoices now produce a plain message ("PayPal says this invoice can't be changed in its current state... press Sync") instead of the raw error.

## Real error hit during this work (explained by hand)

`422 UNPROCESSABLE_ENTITY`, issue `CANNOT_REMIND_INVOICE`, debug_id `f34268289bfd1`, from reminding a draft on purpose: "You cannot remind an invoice which is in DRAFT status. Only UNPAID, SENT and PARTIALLY_PAID invoices can be reminded."

- **Cause:** a reminder sent for an invoice that is not open. In ClearDue this can only happen if the local status is stale, because the mandate already denies reminders on invoices that aren't open.
- **Fix:** mapped to "PayPal only sends reminders for invoices that have been sent and are still unpaid. Press Sync to see the invoice's current state." (with the PayPal reference), and pinned by a test.

## Chosen not to fix

- Local `PAYPAL_WEBHOOK_ID` mismatch: a secret in a developer's `.env`, see above.
- Negative testing on the Invoicing API: not supported by this sandbox app, see above.
- Transaction Search returned `403 NOT_AUTHORIZED` (debug_id f502610f2fe1b): it is not enabled for the sandbox app, so no live payments source was built. Enable it in the developer dashboard (it can take 10 to 15 minutes to apply).
