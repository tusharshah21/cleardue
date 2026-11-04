// Recorded responses for the seeded demo stories, replayed when DEMO_MODE=true.
// Each fixture is keyed by a task tag plus a phrase from the seeded client reply.
import type { LanguageModelV4Content } from "@ai-sdk/provider";
import { TASK_TAG as CLASSIFY } from "./prompts/classify-reply";
import { TASK_TAG as PAYER } from "./prompts/payer-assistant";
import { TASK_TAG as PROPOSE } from "./prompts/propose-action";
import { TASK_TAG as SCOPE } from "./prompts/scope-check";
import type { Fixture } from "./replay";

const text = (value: unknown): LanguageModelV4Content[] => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
const calls = (...c: [string, Record<string, unknown>][]): LanguageModelV4Content[] =>
  c.map(([toolName, input], i) => ({ type: "tool-call", toolCallId: `demo-${toolName}-${i}`, toolName, input: JSON.stringify(input) }));

const ACME = "waiting on finance sign-off";
const BRIGHTSIDE = "Cash is tight this month";
/** The seeded history client (src/lib/demo-history.ts): its reply, and the recorded diagnosis and proposals for it. */
export const NORTHWIND = "Cash is tight at the studio this quarter";
/** The demo's scope-check request for Acme. */
export const ACME_EXTRA = "Could you also build the dashboard in React?";
/** A plan request on a pay page (any client). */
export const KOALA_PLAN = "Can I pay this in two parts?";
/** The suggested question on Koala's pay page. */
export const KOALA = "What does 'Responsive QA' cover?";

export const DEMO_FIXTURES: Fixture[] = [
  {
    task: CLASSIFY,
    match: ACME,
    steps: [
      text({
        reason: "awaiting_approval",
        confidence: 0.93,
        evidence: ["waiting on finance sign-off", "should clear next week"],
        promisedDate: null,
        approverEmail: null,
        summary: "Dana isn't refusing to pay: the invoice is stuck in Acme's finance approval and is expected to clear next week.",
      }),
    ],
  },
  {
    task: PROPOSE,
    match: ACME,
    steps: [
      calls(
        [
          "send_invoice_reminder",
          {
            invoice_id: "{{invoice_id}}",
            tone: "friendly",
            subject: "Invoice for the analytics dashboard redesign",
            note: "Hello Acme accounts payable team, Dana mentioned this invoice is waiting on finance sign-off, so I'm sending it to you directly. Everything you need is in the PayPal invoice. Thanks so much! Aarav",
            additional_recipients: ["{{approver_email}}"],
          },
        ],
        ["pause_reminders", { until: "{{in_7_days}}", reason: "Waiting on Acme finance sign-off; check back in a week." }],
      ),
      text("Proposed sending the invoice to Acme's accounts payable contact and pausing reminders for a week while finance signs off."),
    ],
  },
  {
    task: CLASSIFY,
    match: BRIGHTSIDE,
    steps: [
      text({
        reason: "cash_constraint",
        confidence: 0.95,
        evidence: ["Cash is tight this month", "can we split it?"],
        promisedDate: null,
        approverEmail: null,
        summary: "Sam wants to pay but is short on cash this month and is asking to split the invoice.",
      }),
    ],
  },
  {
    task: PROPOSE,
    match: BRIGHTSIDE,
    steps: [
      calls([
        "offer_payment_plan",
        {
          instalments: [
            { amount: "{{suggested_split.0}}", due_date: "{{tomorrow}}" },
            { amount: "{{suggested_split.1}}", due_date: "{{in_30_days}}" },
          ],
          tone: "friendly",
          message:
            "Hi Sam, of course, happy to split it. How about {{currency}} {{suggested_split.0}} now and {{currency}} {{suggested_split.1}} on {{in_30_days}}? I'll send two smaller PayPal invoices so it's easy on your side. You can accept the plan here: {{pay_link}}. Cheers, Aarav",
        },
      ]),
      text("Proposed a two-part payment plan within the mandate."),
    ],
  },
  {
    task: CLASSIFY,
    match: NORTHWIND,
    steps: [
      text({
        reason: "cash_constraint",
        confidence: 0.9,
        evidence: ["Cash is tight at the studio this quarter", "could we split it"],
        promisedDate: null,
        approverEmail: null,
        summary: "Northwind wants to pay but is short on cash this quarter and is asking to split the invoice.",
      }),
    ],
  },
  {
    // Three proposals in one step, so the mandate shows all three outcomes: the plan is within the mandate, the friendly
    // note lands in the client's quiet hours (held for approval), and the firm note is above the tone ceiling (blocked).
    task: PROPOSE,
    match: NORTHWIND,
    steps: [
      calls(
        ["send_message", { to: "client", tone: "friendly", subject: "Splitting the invoice", body: "Hi, thanks for letting me know. I'm happy to split it into two parts; the plan is on its way." }],
        ["send_message", { to: "client", tone: "firm", subject: "Overdue invoice", body: "This invoice is overdue. Please pay the full amount today." }],
        [
          "offer_payment_plan",
          {
            instalments: [
              { amount: "{{suggested_split.0}}", due_date: "{{tomorrow}}" },
              { amount: "{{suggested_split.1}}", due_date: "{{in_30_days}}" },
            ],
            tone: "friendly",
            message: "Hi, of course. How about {{currency}} {{suggested_split.0}} now and {{currency}} {{suggested_split.1}} on {{in_30_days}}? You can accept the plan here: {{pay_link}}. Thanks, Aarav",
          },
        ],
      ),
      text("Offered a two-part plan within the mandate; the friendly note waits for approval and the firm note was blocked."),
    ],
  },
  {
    task: SCOPE,
    match: ACME_EXTRA,
    steps: [
      text({
        verdict: "OUT_OF_SCOPE",
        quotedClauses: ["Out of scope: front-end development, copywriting, mobile app screens.", "UI design: up to 8 screens for the analytics dashboard, desktop and tablet layouts."],
        reasoning: "Building the dashboard in React is front-end development, which the statement of work lists as out of scope. The agreed work ends at design and a Figma handoff.",
        estimatedHours: 32,
        suggestedLineItem: { name: "Front-end build: analytics dashboard (React)", description: "Additional work requested by Acme: building the 8 designed screens in React", hours: 32 },
      }),
    ],
  },
  {
    task: PAYER,
    match: KOALA_PLAN,
    steps: [
      text({
        answer: "I've asked Aarav about paying in parts.",
        citations: [],
        escalate: true,
        escalationReason: "The client asked to pay in parts.",
        complaint: false,
        wantsPlan: true,
      }),
    ],
  },
  {
    task: PAYER,
    match: KOALA,
    steps: [
      text({
        answer:
          "Responsive QA covers testing on the latest two versions of Chrome, Safari, Firefox and Edge, on iOS and Android phones and tablets, at four breakpoints (360, 768, 1024 and 1440 px), including fixes for any layout bugs found. It doesn't include Internet Explorer, legacy browsers or performance optimisation. On this invoice it's a fixed line of AUD 600.00.",
        citations: [
          { source: "scope", quote: "Responsive QA: testing on the latest two versions of Chrome, Safari, Firefox and Edge, on iOS and Android phones and tablets" },
          { source: "scope", quote: "Excludes Internet Explorer, legacy browsers and performance optimisation." },
          { source: "invoice", quote: "Responsive QA: 1 x AUD 600.00" },
        ],
        escalate: false,
        escalationReason: null,
        complaint: false,
      }),
    ],
  },
];
