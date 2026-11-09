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
import { gateContext, loadInvoice, payLink, timeline } from "./cases";
import { checkAction, type MandateResult } from "./mandate";
import { needsRewrite } from "@/lib/script-guard";
import { draftOf, LOCAL_TOOLS, rewriteHint, toAction, withSafeText } from "./tools";

type Input = Record<string, unknown>;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

export interface ReceivableRow {
  invoiceId: string;
  client: string;
  /** The invoice number, or "Part 1 of 2, payment plan for invoice 0070" for an outstanding part of an accepted plan. */
  invoice: string;
  /** For a plan part, the number of the invoice the plan replaced. */
  planPartOf: string | null;
  /** The client's real pay page link, for drafting messages. */
  payLink: string;
  currency: string;
  outstanding: number;
  daysOverdue: number;
  /** 1 when past due, so a chart can count overdue invoices by reason. */
  overdue: number;
  status: string;
  reason: string;
  nextAction: string;
}
export interface DecisionRow {
  invoiceId: string;
  client: string;
  action: string;
  verdict: string;
  outcome: string;
  reasons: string;
  date: string;
}
export interface PlanPartRow {
  invoiceId: string;
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
  // Every invoice, plan parts included: the dashboard's "Total owed" counts the parts, so the analyst must too.
  const invoices = await db.invoice.findMany({
    where: { client: { freelancerId } },
    include: { client: true, planGroup: true, case: { include: { actions: { where: { status: "pending" }, orderBy: { createdAt: "asc" }, take: 1 } } } },
  });
  const numberOf = new Map(invoices.map((i) => [i.id, i.invoiceNumber ?? i.id.slice(-6)]));
  const siblings = new Map<string, typeof invoices>();
  for (const i of invoices) if (i.planGroupId) siblings.set(i.planGroupId, [...(siblings.get(i.planGroupId) ?? []), i].sort((x, y) => x.dueDate.getTime() - y.dueDate.getTime()));
  return invoices
    .filter(isOpen)
    .map((i) => {
      const pending = i.case?.actions[0];
      const group = i.planGroupId ? siblings.get(i.planGroupId) ?? [] : [];
      const isPart = !!i.planGroup && group.length > 0;
      const label = isPart ? `Part ${group.indexOf(i) + 1} of ${group.length}, payment plan for invoice ${numberOf.get(i.planGroup!.originalInvoiceId) ?? "?"}` : (i.invoiceNumber ?? i.id.slice(-6));
      return {
        invoiceId: i.id,
        client: i.client.name,
        invoice: label,
        payLink: payLink(i),
        planPartOf: isPart ? (numberOf.get(i.planGroup!.originalInvoiceId) ?? null) : null,
        currency: i.currency,
        outstanding: Number(fromMinor(i.totalMinor - i.paidMinor, i.currency)),
        daysOverdue: daysOverdue(i, now),
        overdue: daysOverdue(i, now) > 0 ? 1 : 0,
        status: invoiceStatusLabel(i.status, daysOverdue(i, now)),
        reason: isPart ? "Payment plan" : i.case?.reason ? (REASON_LABELS[i.case.reason] ?? i.case.reason) : "Not diagnosed",
        nextAction: isPart ? (daysOverdue(i, now) > 0 ? "Plan part is overdue: remind the client" : "Waiting for the due date") : pending ? `Approve: ${describeProposal(pending.type, pending.params as Record<string, unknown>).title}` : i.case?.reason ? "Waiting on the client" : "Run Diagnose now",
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
    invoiceId: p.case.invoiceId,
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
      invoiceId: p.id,
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

export interface ClientRow {
  clientId: string;
  client: string;
}
/** One row per invoice that reached PayPal: the hub the other tables join through (invoiceId), and the source of the
 * collection-rate KPI. A plan's replaced original is kept (its proposals join through it) but not counted as issued,
 * so a split invoice counts once per part. */
export interface InvoiceRow {
  invoiceId: string;
  clientId: string;
  client: string;
  invoice: string;
  issued: string;
  status: string;
  issuedCount: number;
  paidCount: number;
  /** Whole days from issue to payment; null until paid. */
  daysToPaid: number | null;
  /** Paid this calendar month after its due date had passed. */
  recoveredThisMonth: number;
}

const PAID_STATUSES = ["PAID", "MARKED_AS_PAID"];

export function invoiceRow(
  i: { id: string; clientId: string; invoiceNumber: string | null; status: string; issueDate: Date; dueDate: Date; updatedAt: Date; client: { name: string } },
  opts: { paidAt: Date | null; replaced: boolean; now: Date },
): InvoiceRow {
  const paid = PAID_STATUSES.includes(i.status);
  const paidAt = paid ? (opts.paidAt ?? i.updatedAt) : null;
  const sameMonth = (d: Date) => d.getUTCFullYear() === opts.now.getUTCFullYear() && d.getUTCMonth() === opts.now.getUTCMonth();
  return {
    invoiceId: i.id,
    clientId: i.clientId,
    client: i.client.name,
    invoice: i.invoiceNumber ?? i.id.slice(-6),
    issued: ymd(i.issueDate),
    status: invoiceStatusLabel(i.status),
    issuedCount: opts.replaced ? 0 : 1,
    paidCount: paid ? 1 : 0,
    daysToPaid: paidAt ? Math.max(0, Math.round((paidAt.getTime() - i.issueDate.getTime()) / 86_400_000)) : null,
    recoveredThisMonth: paidAt && sameMonth(paidAt) && ymd(paidAt) > ymd(i.dueDate) ? 1 : 0,
  };
}

export async function clientsFor(freelancerId: string): Promise<ClientRow[]> {
  const clients = await db.client.findMany({ where: { freelancerId }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  return clients.map((c) => ({ clientId: c.id, client: c.name }));
}

export async function invoicesFor(freelancerId: string, now = new Date()): Promise<InvoiceRow[]> {
  const invoices = await db.invoice.findMany({ where: { client: { freelancerId }, status: { not: "DRAFT" } }, include: { client: true }, orderBy: { issueDate: "asc" } });
  const ids = invoices.map((i) => i.id);
  const [plans, paidEvents] = await Promise.all([
    db.planGroup.findMany({ where: { originalInvoiceId: { in: ids }, state: { not: "aborted" } }, select: { originalInvoiceId: true } }),
    // When the status turned paid, as recorded by syncInvoice ("PayPal status SENT → PAID (...)").
    db.timelineEvent.findMany({ where: { invoiceId: { in: ids }, kind: "status_changed", OR: [{ summary: { contains: "→ PAID" } }, { summary: { contains: "→ MARKED_AS_PAID" } }] }, orderBy: { createdAt: "asc" }, select: { invoiceId: true, createdAt: true } }),
  ]);
  const replaced = new Set(plans.map((p) => p.originalInvoiceId));
  const paidAt = new Map<string, Date>();
  for (const e of paidEvents) if (!paidAt.has(e.invoiceId)) paidAt.set(e.invoiceId, e.createdAt);
  // Paid rows first: AG Studio infers a column's type from its first values, and a leading run of nulls in daysToPaid
  // leaves it untyped (every measure on it comes back empty).
  return invoices.map((i) => invoiceRow(i, { paidAt: paidAt.get(i.id) ?? null, replaced: replaced.has(i.id), now })).sort((a, b) => (b.daysToPaid ?? -1) - (a.daysToPaid ?? -1));
}

export const ANALYST_TOOLS =["send_message", "pause_reminders", "offer_payment_plan", "escalate_dispute"] as const;

export type AnalystProposal =
  | { status: "queued_for_freelancer_approval"; proposalId: string; reasons: string[] }
  | { status: "denied"; proposalId: string; reasons: string[] }
  | { status: "error"; error: string };

/** The analyst's one write path. Mandate-checked like any agent action, but never auto-executed: allow is
 * downgraded to "needs your approval". Deny stays deny. Approving it later re-checks the mandate (approveProposal). */
export async function proposeFromAnalyst(
  freelancerId: string,
  args: { invoice: string; tool: (typeof ANALYST_TOOLS)[number]; input: Record<string, unknown>; /** Second try with bad wording: use the plain template. */ safeText?: boolean },
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
  if (args.safeText) args = { ...args, input: withSafeText(args.tool, args.input, { freelancerName: invoice.client.freelancer.name, payLink: payLink(invoice), invoiceNumber: invoice.invoiceNumber }) };
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
  const textRetries = new Set<string>();
  const write = (name: (typeof ANALYST_TOOLS)[number]) =>
    tool({
      description: `${LOCAL_TOOLS[name].description} This only PROPOSES: the freelancer approves it on the Approvals page before anything is sent or changed. invoice is a client name or the invoice id from get_receivables.`,
      inputSchema: z.object({ invoice: z.string().min(1).describe("Client name or invoice id of an open invoice") }).extend((LOCAL_TOOLS[name].schema as z.ZodObject<z.ZodRawShape>).shape) as unknown as z.ZodType<Input>,
      execute: async ({ invoice, ...rawInput }: Input) => {
        let safeText = false;
        if (needsRewrite(rawInput)) {
          // The model gets one retry per tool; after that the wording is replaced with a plain template (real name and pay link).
          if (!textRetries.has(name)) {
            textRetries.add(name);
            return { status: "error", error: rewriteHint(rawInput) } satisfies AnalystProposal;
          }
          safeText = true;
        }
        return proposeFromAnalyst(freelancerId, { invoice: String(invoice), tool: name, input: rawInput, safeText });
      },
    });
  return {
    get_receivables: tool({ description: "Open receivables: client, outstanding amount, days overdue, diagnosed reason, next action. One row per open invoice, and one per unpaid part of an accepted payment plan (labelled as a plan part of its original invoice; the replaced original is not listed, so the amounts add up to what is owed).", inputSchema: z.object({}), execute: () => receivablesFor(freelancerId) }),
    get_decisions: tool({ description: "The latest agent proposals with the mandate's verdict (allow, needs_approval or deny), outcome and reasons.", inputSchema: z.object({}), execute: () => decisionsFor(freelancerId) }),
    get_plans: tool({ description: "Payment plans: each instalment's client, amount, due date and status.", inputSchema: z.object({}), execute: () => plansFor(freelancerId) }),
    ...Object.fromEntries(ANALYST_TOOLS.map((n) => [`propose_${n}`, write(n)])),
  };
}
