# ClearDue demo script

Target length: 2:40 (hard limit 2:45; the video must stay under 3:00). Record at 1280×800 with the PayPal sandbox and live AI calls (`PAYPAL_MODE=sandbox`, `DEMO_MODE=false`). Seed first with `npm run seed:paypal` and sign in before recording. If a live call is slow on the day, record with `DEMO_MODE=true`; the "Replayed response" labels then stay visible in the video.

| Time | Screen | Voiceover |
| --- | --- | --- |
| 0:00 to 0:12 | Title card: "85% of freelancers have been paid late." Source line underneath. | "85% of freelancers have been paid late. For a solo designer in India billing clients in New York, London and Sydney, chasing those invoices is a second job." |
| 0:12 to 0:25 | Dashboard: AG Grid with Acme (USD 2,400), Brightside (GBP 1,800), Koala (AUD 3,200), all real PayPal sandbox invoices. | "This is ClearDue. Meet Aarav, a freelancer in India. Three clients, three PayPal invoices, three different reasons they haven't paid. ClearDue's job is to find out why, and do the right thing about it." |
| 0:25 to 1:00 | Acme invoice (autopilot on). Dana's reply: "waiting on finance sign-off". Click **Diagnose now**; the stages tick through reading, diagnosing, proposing. Result: Awaiting approval, with the quoted evidence. The actions panel shows the PayPal reminder to Acme's AP contact and a one-week pause, both marked "Done by autopilot" with the mandate reason "within mandate". Timeline: "Autopilot sent a PayPal reminder to the client and their AP contact". On-screen text: **"No click: within Aarav's mandate"**. | "Dana from Acme says it's waiting on finance. ClearDue diagnoses it: awaiting approval, with Dana's own words as evidence. So it doesn't nag Dana. It sends the PayPal reminder straight to Acme's accounts payable team and pauses reminders for a week. Nobody clicked anything: Aarav turned on autopilot for Acme, and every action passed his mandate, plain TypeScript rules for tone, quiet hours and who can be contacted." |
| 1:00 to 1:15 | Acme invoice > **Client asking for more?** Paste "Could you also build the dashboard in React?" Result: OUT_OF_SCOPE with two quoted clauses, 32 h. Click **Add to draft invoice**. | "Then Dana asks for a React build. ClearDue checks the statement of work: front-end development is out of scope. It quotes the clause and drafts a PayPal invoice line for 32 hours." |
| 1:15 to 1:50 | Brightside: Sam's reply "Cash is tight this month, can we split it?" Diagnose: Cash constraint. Switch to Sam's pay page: plan options. Click **Accept this plan** (GBP 900 now, GBP 900 in 30 days): "Aarav will confirm your plan shortly." Approvals: "Client accepted a 2-part plan" with the reason "autopilot is off for this client", **Approve**. Sam's page updates by itself: two new invoices; the original is cancelled. | "Brightside is different: Sam wants to pay, but cash is tight, so Sam's page offers a plan. Autopilot is off for Brightside, so Aarav confirms it. PayPal doesn't allow partial payments for merchants in India, so ClearDue replaces the invoice with two smaller PayPal invoices: new ones first, the original re-checked and cancelled silently, then sent. Sam is never left without something to pay." |
| 1:50 to 2:20 | Koala's pay page. Click "What does 'Responsive QA' cover?" Answer with three quoted citations. Type "Can you give me a 50% discount?": the reply says it was passed to Aarav. Cut to Approvals: the task "Needs your reply". | "Koala has a question before paying. The pay page answers only from the agreed scope and the invoice, with quotes. When the client asks for something only Aarav can decide, like a discount, the AI isn't allowed to invent it. Any figure that isn't in the sources is blocked, and the question goes to Aarav." |
| 2:20 to 2:32 | Koala pays in the PayPal sandbox. Back in ClearDue: status PAID, timeline "SENT to PAID (webhook INVOICING.INVOICE.PAID)", task closed. | "Koala pays through PayPal. A verified webhook marks the invoice paid and closes the open task. No more chasing." |
| 2:32 to 2:40 | End card: ClearDue logo, "Diagnose. Act within your rules. Get paid." Repo URL. | "ClearDue. The AI proposes, your rules decide, and PayPal gets you paid." |

## Checklist before recording

- `.env` has sandbox credentials, `PAYPAL_MODE=sandbox`, `ANTHROPIC_API_KEY` and `AI_MODEL`.
- `npm run seed:paypal` ran on the recording database, and the webhook is registered for the app's public URL.
- Signed in as the demo user; the browser zoom is 100% and notifications are off.
- Koala's sandbox payer account is logged in on a second tab for the 2:20 payment.
- Record while it's daytime in New York (8:00 to 20:00 there, so 18:30 to 06:30 IST in November): Acme's reminder is a client contact, and outside those hours quiet hours send it to Approvals instead of running it.
- Run the whole flow once off camera; reseed before the real take.

## Source for the opening line

85% of freelancers have experienced late payment: [Plutio, citing Freelancers Union](https://www.plutio.com/freelancer-magazine/late-invoice-payments).
