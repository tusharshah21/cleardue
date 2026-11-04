// The collections analyst: read-only views over the freelancer's receivables, mandate decisions and payment plans
// (the data behind the /analyst dashboard and the analyst agent's tools), and `proposeFromAnalyst`, the only way the
// analyst can act. It goes through the same mandate check as the diagnosis agent, but nothing the analyst proposes
// runs on its own: it always lands on Approvals, because nobody diagnosed the case it is acting on.
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { invoiceStatusLabel } from "@/components/status-badge";
import { db } from "@/lib/db";
import { fromMinor } from "@/lib/money";
import { describeProposal, REASON_LABELS, STATUS_LABELS } from "@/lib/proposals";
import { daysOverdue, isOpen } from "@/lib/receivables";
import { gateContext, loadInvoice, timeline } from "./cases";
import { checkAction, type MandateResult } from "./mandate";
import { draftOf, LOCAL_TOOLS, toAction } from "./tools";

type Input = Record<string, unknown>;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

export interface ReceivableRow {
  invoiceId: string;
  client: string;
  invoice: string;
  currency: string;
  outstanding: number;
  daysOverdue: number;
  status: string;
  reason: string;
  nextAction: string;
}
export interface DecisionRow {
  client: string;
  action: string;
  verdict: string;
  outcome: string;
  reasons: string;
  date: string;
}
export interface PlanPartRow {
  client: string;
  plan: string;
  strategy: string;
  part: string;
  currency: string;
  amount: number;
  due: string;
  status: string;
  paid: number;
}

export async function receivablesFor(freelancerId: string, now = new Date()): Promise<ReceivableRow[]> {
  const invoices = await db.invoice.findMany({
    where: { client: { freelancerId }, planGroupId: null },
    include: { client: true, case: { include: { actions: { where: { status: "pending" }, orderBy: { createdAt: "asc" }, take: 1 } } } },
  });
  return invoices
    .filter(isOpen)
    .map((i) => {
      const pending = i.case?.actions[0];
      return {
        invoiceId: i.id,
        client: i.client.name,
        invoice: i.invoiceNumber ?? i.id.slice(-6),
        currency: i.currency,
        outstanding: Number(fromMinor(i.totalMinor - i.paidMinor, i.currency)),
        daysOverdue: daysOverdue(i, now),
        status: invoiceStatusLabel(i.status, daysOverdue(i, now)),
        reason: i.case?.reason ? (REASON_LABELS[i.case.reason] ?? i.case.reason) : "Not diagnosed",
        nextAction: pending ? `Approve: ${describeProposal(pending.type, pending.params as Record<string, unknown>).title}` : i.case?.reason ? "Waiting on the client" : "Run Diagnose now",
      };
    })
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
}

export async function decisionsFor(freelancerId: string): Promise<DecisionRow[]> {
  const rows = await db.proposedAction.findMany({
    where: { case: { invoice: { client: { freelancerId } } } },
    include: { case: { include: { invoice: { include: { client: true } } } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return rows.map((p) => ({
    client: p.case.invoice.client.name,
    action: describeProposal(p.type, p.params as Record<string, unknown>).title,
    verdict: p.mandateVerdict,
    outcome: STATUS_LABELS[p.status] ?? p.status,
    reasons: (p.mandateReasons as string[]).join("; "),
    date: ymd(p.createdAt),
  }));
}

const STRATEGY_LABELS: Record<string, string> = { split_invoices: "Split invoices", partial_payment: "Part payments" };

export async function plansFor(freelancerId: string): Promise<PlanPartRow[]> {
  const parts = await db.invoice.findMany({
    where: { client: { freelancerId }, planGroupId: { not: null } },
    include: { client: true, planGroup: true },
    orderBy: [{ planGroupId: "asc" }, { dueDate: "asc" }],
  });
  const seen = new Map<string, number>();
  return parts.map((p) => {
    const n = (seen.get(p.planGroupId!) ?? 0) + 1;
    seen.set(p.planGroupId!, n);
    const paid = p.status === "PAID" || p.status === "MARKED_AS_PAID";
    return {
      client: p.client.name,
      plan: p.planGroupId!.slice(-6),
      strategy: STRATEGY_LABELS[p.planGroup?.strategy ?? ""] ?? "Plan",
      part: `Part ${n}`,
      currency: p.currency,
      amount: Number(fromMinor(p.totalMinor, p.currency)),
      due: ymd(p.dueDate),
      status: invoiceStatusLabel(p.status, isOpen(p) ? daysOverdue(p) : 0),
      paid: paid ? 1 : 0,
    };
  });
}

export const ANALYST_TOOLS = ["send_message", "pause_reminders", "offer_payment_plan", "escalate_dispute"] as const;

export type AnalystProposal =
  | { status: "queued_for_freelancer_approval"; proposalId: string; reasons: string[] }
  | { status: "denied"; proposalId: string; reasons: string[] }
  | { status: "error"; error: string };

/** The analyst's one write path. Mandate-checked like any agent action, but never auto-executed: allow is
 * downgraded to "needs your approval". Deny stays deny. Approving it later re-checks the mandate (approveProposal). */
export async function proposeFromAnalyst(
  freelancerId: string,
  args: { invoice: string; tool: (typeof ANALYST_TOOLS)[number]; input: Record<string, unknown> },
  now = new Date(),
): Promise<AnalystProposal> {
  const needle = args.invoice.trim().toLowerCase();
  const candidates = await db.invoice.findMany({ where: { client: { freelancerId }, planGroupId: null }, include: { client: true } });
  const matches = candidates.filter(isOpen).filter((i) => i.id === args.invoice || i.invoiceNumber === args.invoice || i.client.name.toLowerCase().includes(needle));
  if (matches.length !== 1) {
    return { status: "error", error: matches.length ? `"${args.invoice}" matches ${matches.length} open invoices; use the invoice id` : `No open invoice matches "${args.invoice}"` };
  }
  const invoice = await loadInvoice(matches[0].id, freelancerId);
  const kase = await db.case.upsert({ where: { invoiceId: invoice.id }, create: { invoiceId: invoice.id, state: "open" }, update: {} });
  // The analyst's confidence is not the diagnosis' confidence, so a case nobody diagnosed isn't blocked by a 0.
  const ctx = gateContext(invoice, { state: kase.state, confidence: kase.confidence ?? 1 }, now);
  let result: MandateResult;
  try {
    result = checkAction(toAction(args.tool, args.input, ctx), ctx.mandate);
  } catch (e) {
    result = { verdict: "deny", reasons: [`invalid ${args.tool} request: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const denied = result.verdict === "deny";
  const reasons = denied ? result.reasons : [...result.reasons.filter((r) => !r.startsWith("within mandate")), "proposed by the collections analyst, so it always needs your approval"];
  const row = await db.proposedAction.create({
    data: {
      caseId: kase.id,
      type: args.tool,
      params: json(args.input),
      draft: draftOf(args.tool, args.input),
      confidence: kase.confidence,
      mandateVerdict: denied ? "deny" : "needs_approval",
      mandateReasons: json(reasons),
      status: denied ? "denied" : "pending",
    },
  });
  await timeline(
    invoice.id,
    kase.id,
    `proposal_${denied ? "deny" : "needs_approval"}`,
    `The collections analyst proposed ${describeProposal(args.tool, args.input).title.toLowerCase()}: ${denied ? "blocked by your mandate" : "waiting for your approval"} (${reasons.join("; ")})`,
  );
  return denied ? { status: "denied", proposalId: row.id, reasons } : { status: "queued_for_freelancer_approval", proposalId: row.id, reasons };
}

/** The analyst agent's server-side tools (run inside the route's model loop). Everything is scoped to the freelancer. */
export function analystTools(freelancerId: string): ToolSet {
  const write = (name: (typeof ANALYST_TOOLS)[number]) =>
    tool({
      description: `${LOCAL_TOOLS[name].description} This only PROPOSES: the freelancer approves it on the Approvals page before anything is sent or changed. invoice is a client name or the invoice id from get_receivables.`,
      inputSchema: z.object({ invoice: z.string().min(1).describe("Client name or invoice id of an open invoice") }).extend((LOCAL_TOOLS[name].schema as z.ZodObject<z.ZodRawShape>).shape) as unknown as z.ZodType<Input>,
      execute: async ({ invoice, ...input }: Input) => proposeFromAnalyst(freelancerId, { invoice: String(invoice), tool: name, input }),
    });
  return {
    get_receivables: tool({ description: "Open invoices: client, outstanding amount, days overdue, diagnosed reason, next action. One row per open invoice.", inputSchema: z.object({}), execute: () => receivablesFor(freelancerId) }),
    get_decisions: tool({ description: "The latest agent proposals with the mandate's verdict (allow, needs_approval or deny), outcome and reasons.", inputSchema: z.object({}), execute: () => decisionsFor(freelancerId) }),
    get_plans: tool({ description: "Payment plans: each instalment's client, amount, due date and status.", inputSchema: z.object({}), execute: () => plansFor(freelancerId) }),
    ...Object.fromEntries(ANALYST_TOOLS.map((n) => [`propose_${n}`, write(n)])),
  };
}
