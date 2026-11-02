// Recorded responses for the seeded demo stories, replayed when DEMO_MODE=true.
// Each fixture is keyed by a task tag plus a phrase from the seeded client reply.
import type { LanguageModelV4Content } from "@ai-sdk/provider";
import { TASK_TAG as CLASSIFY } from "./prompts/classify-reply";
import { TASK_TAG as PROPOSE } from "./prompts/propose-action";
import type { Fixture } from "./replay";

const text = (value: unknown): LanguageModelV4Content[] => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
const calls = (...c: [string, Record<string, unknown>][]): LanguageModelV4Content[] =>
  c.map(([toolName, input], i) => ({ type: "tool-call", toolCallId: `demo-${toolName}-${i}`, toolName, input: JSON.stringify(input) }));

const ACME = "waiting on finance sign-off";
const BRIGHTSIDE = "Cash is tight this month";

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
      text("Sent the invoice to Acme's accounts payable contact and paused reminders for a week while finance signs off."),
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
      text("Offered a two-part payment plan within the mandate."),
    ],
  },
];
