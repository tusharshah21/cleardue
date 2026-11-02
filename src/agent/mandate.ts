// The mandate: limits the freelancer sets, enforced in code. The LLM proposes an AgentAction;
// checkAction() decides allow / needs_approval / deny. Pure functions only, no I/O.
import { z } from "zod";

export const Tone = z.enum(["friendly", "firm", "formal"]);
export type Tone = z.infer<typeof Tone>;
const TONE_RANK: Record<Tone, number> = { friendly: 0, firm: 1, formal: 2 };

export const MandateSchema = z.object({
  autopilot: z.boolean(),
  minConfidence: z.number().min(0).max(1),
  maxInstalments: z.number().int().min(1).max(12),
  minFirstPayment: z.union([
    z.object({ kind: z.literal("percent"), value: z.number().min(0).max(100) }),
    z.object({ kind: z.literal("amount"), valueMinor: z.number().int().min(0) }),
  ]),
  /** Latest acceptable final payment date, as days after the original due date. */
  maxPlanDays: z.number().int().min(0),
  toneCeiling: Tone,
  neverAutoContact: z.boolean(),
  /** Local hours in the client's timezone; start > end wraps midnight; start == end means none. */
  quietHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }),
});

export type Mandate = z.infer<typeof MandateSchema>;

export const DEFAULT_MANDATE: Mandate = {
  autopilot: false,
  minConfidence: 0.85,
  maxInstalments: 3,
  minFirstPayment: { kind: "percent", value: 30 },
  maxPlanDays: 60,
  toneCeiling: "firm",
  neverAutoContact: false,
  quietHours: { start: 20, end: 8 },
};

/** Client overrides win over the freelancer default, field by field. */
export function effectiveMandate(base: unknown, override: unknown): Mandate {
  const parsedBase = MandateSchema.parse(base ?? DEFAULT_MANDATE);
  return MandateSchema.parse({ ...parsedBase, ...MandateSchema.partial().parse(override ?? {}) });
}

export interface Instalment {
  amountMinor: number;
  dueDate: Date;
}

export type AgentAction =
  | { type: "read_invoice"; invoiceId: string }
  | { type: "escalate_to_freelancer"; summary: string }
  | { type: "pause_reminders"; until: Date }
  | { type: "send_message"; to: "client" | "approver"; tone: Tone; body: string }
  | { type: "send_reminder"; invoiceId: string; tone: Tone; note: string; additionalRecipients: string[] }
  | { type: "offer_plan"; instalments: Instalment[] }
  | { type: "cancel_invoice"; invoiceId: string }
  | { type: "record_payment"; invoiceId: string; amountMinor: number };

export type ActionType = AgentAction["type"];

export interface MandateContext {
  mandate: Mandate;
  caseState: "open" | "paused" | "dispute" | "resolved";
  confidence: number;
  now: Date;
  clientTimezone: string;
  /** Addresses the agent may contact: the client and, if set, the approver. */
  knownRecipients: string[];
  invoice: {
    paypalInvoiceId: string | null;
    status: string;
    totalMinor: number;
    paidMinor: number;
    dueDate: Date;
  };
}

export type Verdict = "allow" | "needs_approval" | "deny";
export interface MandateResult {
  verdict: Verdict;
  reasons: string[];
}

const OPEN = ["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED", "PAYMENT_PENDING"];
const PAID = ["PAID", "MARKED_AS_PAID", "PARTIALLY_PAID"];
const DAY = 86_400_000;
const startOfDay = (d: Date) => Math.floor(d.getTime() / DAY);

export function hourIn(timezone: string, at: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(at));
}

export function inQuietHours(q: Mandate["quietHours"], timezone: string, at: Date): boolean {
  if (q.start === q.end) return false;
  const h = hourIn(timezone, at);
  return q.start > q.end ? h >= q.start || h < q.end : h >= q.start && h < q.end;
}

export const exceedsTone = (tone: Tone, ceiling: Tone) => TONE_RANK[tone] > TONE_RANK[ceiling];

const CONTACTS: ActionType[] = ["send_message", "send_reminder"];
const ALWAYS_APPROVAL: ActionType[] = ["cancel_invoice", "record_payment"];
const INTERNAL: ActionType[] = ["read_invoice", "escalate_to_freelancer"];

function planProblems(plan: Instalment[], ctx: MandateContext): string[] {
  const { mandate, invoice, now } = ctx;
  const outstanding = invoice.totalMinor - invoice.paidMinor;
  const problems: string[] = [];
  if (plan.length < 2) problems.push("a plan needs at least 2 instalments");
  if (plan.length > mandate.maxInstalments) problems.push(`plan has ${plan.length} instalments; mandate allows ${mandate.maxInstalments}`);
  if (plan.some((p) => !Number.isInteger(p.amountMinor) || p.amountMinor <= 0)) problems.push("every instalment must be a positive whole minor-unit amount");
  const sum = plan.reduce((s, p) => s + p.amountMinor, 0);
  if (sum !== outstanding) problems.push(`instalments sum to ${sum} but ${outstanding} is outstanding`);
  const first = plan[0]?.amountMinor ?? 0;
  const min = mandate.minFirstPayment;
  if (min.kind === "percent" ? first * 100 < min.value * outstanding : first < min.valueMinor) {
    problems.push(min.kind === "percent" ? `first payment is below the ${min.value}% minimum` : `first payment is below the ${min.valueMinor} minimum`);
  }
  if (plan.some((p, i) => i > 0 && startOfDay(p.dueDate) <= startOfDay(plan[i - 1].dueDate))) problems.push("instalment dates must be strictly increasing");
  if (plan.length && startOfDay(plan[0].dueDate) < startOfDay(now)) problems.push("first instalment is in the past");
  const latest = invoice.dueDate.getTime() + mandate.maxPlanDays * DAY;
  if (plan.length && startOfDay(plan[plan.length - 1].dueDate) > startOfDay(new Date(latest))) {
    problems.push(`final instalment is later than ${mandate.maxPlanDays} days after the original due date`);
  }
  return problems;
}

export function checkAction(action: AgentAction, ctx: MandateContext): MandateResult {
  const { mandate, invoice } = ctx;
  const deny: string[] = [];
  const approval: string[] = [];

  // Case state gates everything.
  if (ctx.caseState === "resolved" && action.type !== "read_invoice") deny.push("case is resolved; no further actions");
  if (ctx.caseState === "dispute" && !INTERNAL.includes(action.type)) {
    if (action.type === "send_message") approval.push("case is in dispute; replies are drafts for the freelancer to review");
    else deny.push("case is in dispute; automation is stopped");
  }

  // The agent may only touch this case's invoice.
  if ("invoiceId" in action && action.invoiceId !== invoice.paypalInvoiceId) deny.push("action targets a different invoice");

  switch (action.type) {
    case "read_invoice":
    case "escalate_to_freelancer":
      break;
    case "pause_reminders": {
      if (startOfDay(action.until) <= startOfDay(ctx.now)) deny.push("pause date must be in the future");
      const latest = invoice.dueDate.getTime() + mandate.maxPlanDays * DAY;
      if (startOfDay(action.until) > startOfDay(new Date(latest))) deny.push(`pause runs past ${mandate.maxPlanDays} days after the due date`);
      break;
    }
    case "send_message":
    case "send_reminder": {
      if (exceedsTone(action.tone, mandate.toneCeiling)) deny.push(`tone "${action.tone}" exceeds the "${mandate.toneCeiling}" ceiling`);
      const body = action.type === "send_message" ? action.body : action.note;
      if (!body.trim()) deny.push("message is empty");
      if (action.type === "send_reminder") {
        if (!OPEN.includes(invoice.status)) deny.push(`invoice is ${invoice.status}; nothing to remind about`);
        const known = new Set(ctx.knownRecipients.map((r) => r.toLowerCase()));
        const strangers = action.additionalRecipients.filter((r) => !known.has(r.toLowerCase()));
        if (strangers.length) deny.push(`unknown recipients: ${strangers.join(", ")}`);
      }
      if (mandate.neverAutoContact) approval.push("client is marked never-auto-contact");
      if (inQuietHours(mandate.quietHours, ctx.clientTimezone, ctx.now)) approval.push("inside the client's quiet hours");
      break;
    }
    case "offer_plan":
      if (!OPEN.includes(invoice.status)) deny.push(`invoice is ${invoice.status}; no plan possible`);
      deny.push(...planProblems(action.instalments, ctx));
      break;
    case "cancel_invoice":
      if (PAID.includes(invoice.status) || invoice.paidMinor > 0) deny.push("invoice is paid or partly paid; cannot cancel");
      approval.push("cancelling an invoice always needs the freelancer");
      break;
    case "record_payment":
      if (action.amountMinor <= 0) deny.push("payment amount must be positive");
      if (action.amountMinor > invoice.totalMinor - invoice.paidMinor) deny.push("payment exceeds the outstanding amount");
      approval.push("recording a payment always needs the freelancer");
      break;
  }

  // Autopilot: anything not purely internal runs on its own only when enabled and confident.
  if (!INTERNAL.includes(action.type) && !ALWAYS_APPROVAL.includes(action.type)) {
    if (!mandate.autopilot) approval.push("autopilot is off for this client");
    if (ctx.confidence < mandate.minConfidence) approval.push(`confidence ${ctx.confidence.toFixed(2)} is below ${mandate.minConfidence}`);
  }

  if (deny.length) return { verdict: "deny", reasons: deny };
  if (approval.length) return { verdict: "needs_approval", reasons: [...new Set(approval)] };
  return { verdict: "allow", reasons: [CONTACTS.includes(action.type) ? "within mandate; outside quiet hours" : "within mandate"] };
}
