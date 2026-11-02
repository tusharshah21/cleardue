// Flow C orchestration: diagnose why an invoice is unpaid, let the agent pick gated actions, persist
// everything to the case timeline, and run approvals from the queue.
import type { LanguageModel } from "ai";
import type { Client, Freelancer, Invoice, Message, Prisma } from "@/generated/prisma/client";
import { proposeAction } from "@/ai/propose";
import type { Facts } from "@/ai/prompts/propose-action";
import { getModel } from "@/ai/provider";
import { classifyReply, type ThreadMessage } from "@/ai/tasks";
import type { ClassifyReply } from "@/ai/schemas";
import { db } from "@/lib/db";
import { syncInvoice } from "@/lib/invoicing";
import { formatMoney, fromMinor, splitEvenly } from "@/lib/money";
import { daysOverdue, isOpen } from "@/lib/receivables";
import { checkAction, effectiveMandate, type MandateContext } from "./mandate";
import { toolkitTools, TOOLKIT_TOOLS, type ToolkitToolName } from "./toolkit";
import { buildAgentTools, draftOf, toAction, type GateContext, type GateHooks, type Proposal } from "./tools";

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

type FullInvoice = Invoice & { client: Client & { freelancer: Freelancer }; messages: Message[] };

async function loadInvoice(invoiceId: string, freelancerId: string): Promise<FullInvoice> {
  const invoice = await db.invoice.findFirst({
    where: { id: invoiceId, client: { freelancerId } },
    include: { client: { include: { freelancer: true } }, messages: { orderBy: { sentAt: "asc" } } },
  });
  if (!invoice) throw new Error("Invoice not found");
  return invoice;
}

const toThread = (messages: Message[]): ThreadMessage[] =>
  messages.map((m) => ({ from: m.direction === "INBOUND" ? "client" : "freelancer", at: m.sentAt, body: m.body }));

const payLink = (invoice: Invoice) => `${process.env.APP_URL ?? "http://localhost:3000"}/pay/${invoice.payToken}`;

async function timeline(invoiceId: string, caseId: string | null, kind: string, summary: string, data?: unknown) {
  await db.timelineEvent.create({ data: { invoiceId, caseId, kind, summary, ...(data !== undefined && { data: json(data) }) } });
}

function gateContext(invoice: FullInvoice, c: { state: string; confidence: number | null }, now: Date): GateContext {
  const { client } = invoice;
  const mandate: MandateContext = {
    mandate: effectiveMandate(client.freelancer.mandate, client.mandate),
    caseState: c.state as MandateContext["caseState"],
    confidence: c.confidence ?? 0,
    now,
    clientTimezone: client.timezone,
    knownRecipients: [client.email, ...(client.approverEmail ? [client.approverEmail] : [])],
    invoice: {
      paypalInvoiceId: invoice.paypalInvoiceId,
      status: invoice.status,
      totalMinor: invoice.totalMinor,
      paidMinor: invoice.paidMinor,
      dueDate: invoice.dueDate,
    },
  };
  return { mandate, currency: invoice.currency, approverEmail: client.approverEmail };
}

function buildFacts(invoice: FullInvoice, ctx: GateContext, promisedDate: string | null, now: Date): Facts {
  const { mandate } = ctx.mandate;
  const outstanding = invoice.totalMinor - invoice.paidMinor;
  const min = mandate.minFirstPayment;
  return {
    invoice_id: invoice.paypalInvoiceId ?? "not-on-paypal",
    invoice_status: invoice.status,
    currency: invoice.currency,
    outstanding: fromMinor(outstanding, invoice.currency),
    due_date: ymd(invoice.dueDate),
    days_overdue: daysOverdue(invoice, now),
    today: ymd(now),
    tomorrow: ymd(new Date(now.getTime() + DAY)),
    in_7_days: ymd(new Date(now.getTime() + 7 * DAY)),
    in_30_days: ymd(new Date(now.getTime() + 30 * DAY)),
    pay_link: payLink(invoice),
    approver_email: ctx.approverEmail,
    promised_date_plus_grace: promisedDate ? ymd(new Date(new Date(`${promisedDate}T00:00:00Z`).getTime() + 3 * DAY)) : null,
    suggested_split: splitEvenly(outstanding, 2).map((m) => fromMinor(m, invoice.currency)),
    tone_ceiling: mandate.toneCeiling,
    max_instalments: mandate.maxInstalments,
    min_first_payment: min.kind === "percent" ? `${min.value}% of outstanding` : formatMoney(min.valueMinor, invoice.currency),
    latest_final_payment_date: ymd(new Date(invoice.dueDate.getTime() + mandate.maxPlanDays * DAY)),
  };
}

/** Runs an allowed or approved proposal. PayPal actions go through the Agent Toolkit; the rest are ClearDue effects. */
async function executeProposal(caseId: string, invoice: FullInvoice, p: Pick<Proposal, "toolName" | "input">): Promise<unknown> {
  const { client } = invoice;
  if ((TOOLKIT_TOOLS as readonly string[]).includes(p.toolName)) {
    const args = { ...p.input };
    delete args.tone; // ClearDue-only field, not part of PayPal's API
    const out = await toolkitTools()[p.toolName as ToolkitToolName].run(args);
    if (p.toolName !== "get_invoice") await syncInvoice(invoice).catch(() => undefined);
    return out;
  }
  const i = p.input as Record<string, string>;
  switch (p.toolName) {
    case "send_message":
    case "offer_payment_plan": {
      const to = i.to === "approver" ? client.approverEmail : client.email;
      const body = p.toolName === "send_message" ? i.body : i.message;
      const msg = await db.message.create({
        data: { clientId: client.id, invoiceId: invoice.id, direction: "OUTBOUND", channel: "outbox", toAddr: to, subject: i.subject ?? "Payment plan", body, status: "queued" },
      });
      if (p.toolName === "offer_payment_plan") {
        // The offer is a message; the plan invoices are created when the client accepts it (src/plans/accept.ts).
        await db.case.update({ where: { id: caseId }, data: { state: "paused", pausedUntil: new Date(Date.now() + 7 * DAY) } });
      }
      return { queued: msg.id, to };
    }
    case "pause_reminders":
      await db.case.update({ where: { id: caseId }, data: { state: "paused", pausedUntil: new Date(`${i.until}T00:00:00Z`) } });
      return { pausedUntil: i.until };
    case "escalate_dispute":
      await db.case.update({ where: { id: caseId }, data: { state: "dispute" } });
      return { escalated: true };
    case "manual_review":
      return { acknowledged: true };
    default:
      throw new Error(`Cannot execute ${p.toolName}`);
  }
}

function hooksFor(caseId: string, invoice: FullInvoice, confidence: number, counter: { n: number }): GateHooks {
  return {
    async record(p) {
      counter.n++;
      const row = await db.proposedAction.create({
        data: {
          caseId,
          type: p.toolName,
          params: json(p.input),
          draft: p.draft,
          confidence,
          mandateVerdict: p.result.verdict,
          mandateReasons: json(p.result.reasons),
          status: p.result.verdict === "deny" ? "denied" : "pending",
        },
      });
      await timeline(invoice.id, caseId, `proposal_${p.result.verdict}`, `Agent proposed ${p.toolName}: ${p.result.verdict.replace("_", " ")} (${p.result.reasons.join("; ")})`);
      return row.id;
    },
    async execute(id, p) {
      try {
        const result = await executeProposal(caseId, invoice, p);
        await db.proposedAction.update({ where: { id }, data: { status: "auto_executed", result: json(result), decidedAt: new Date() } });
        await timeline(invoice.id, caseId, "action_executed", `Autopilot ran ${p.toolName}`, result);
        return result;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await db.proposedAction.update({ where: { id }, data: { status: "failed", result: json({ error: message }), decidedAt: new Date() } });
        await timeline(invoice.id, caseId, "action_failed", `${p.toolName} failed: ${message}`);
        throw e;
      }
    },
  };
}

/** A classification, or the fact that the client hasn't replied at all (no AI call, so no guess: confidence 1). */
type Diagnosis = Omit<ClassifyReply, "reason"> & { reason: ClassifyReply["reason"] | "no_response" };

export const noReply = (invoice: Invoice, now: Date): Diagnosis => ({
  reason: "no_response",
  confidence: 1,
  evidence: [],
  promisedDate: null,
  approverEmail: null,
  summary: `The client hasn't replied and the invoice is ${daysOverdue(invoice, now)} days overdue, so a friendly nudge with the pay link comes first.`,
});

/** Progress for the UI, reported as the diagnosis moves through its steps. */
export type Stage = "reading" | "diagnosing" | "proposing" | "saving";

export async function analyzeInvoice(invoiceId: string, freelancerId: string, model: LanguageModel = getModel(), now = new Date(), onStage: (s: Stage) => void = () => {}) {
  onStage("reading");
  let invoice = await loadInvoice(invoiceId, freelancerId);
  const existing = await db.case.findUnique({ where: { invoiceId } });
  if (!isOpen(invoice)) throw new Error(`Invoice is ${invoice.status}; nothing to collect`);
  if (existing?.state === "dispute") throw new Error("Case is in dispute; automation is stopped until you resolve it");

  const thread = toThread(invoice.messages);
  const hasReply = thread.some((m) => m.from === "client");
  if (hasReply) onStage("diagnosing");
  const classification: { value: Diagnosis; fallback: boolean; error?: string } = hasReply
    ? await classifyReply(model, {
        clientName: invoice.client.name,
        invoiceSummary: `${formatMoney(invoice.totalMinor - invoice.paidMinor, invoice.currency)} outstanding, due ${ymd(invoice.dueDate)}, ${daysOverdue(invoice, now)} days overdue`,
        thread,
        now,
      })
    : { value: noReply(invoice, now), fallback: false as const };
  const c = classification.value;

  // An approver address the client gave us (verbatim in their words) becomes a known contact.
  const clientWords = thread.filter((m) => m.from === "client").map((m) => m.body.toLowerCase()).join("\n");
  if (c.approverEmail && !invoice.client.approverEmail && clientWords.includes(c.approverEmail.toLowerCase())) {
    await db.client.update({ where: { id: invoice.client.id }, data: { approverEmail: c.approverEmail } });
    invoice = await loadInvoice(invoiceId, freelancerId);
  }

  const state = c.reason === "dispute" ? "dispute" : "open";
  const kase = await db.case.upsert({
    where: { invoiceId },
    create: { invoiceId, reason: c.reason, confidence: c.confidence, summary: c.summary, evidence: json(c.evidence), state, promisedDate: c.promisedDate ? new Date(`${c.promisedDate}T00:00:00Z`) : null },
    update: { reason: c.reason, confidence: c.confidence, summary: c.summary, evidence: json(c.evidence), state, pausedUntil: null, promisedDate: c.promisedDate ? new Date(`${c.promisedDate}T00:00:00Z`) : null },
  });
  await timeline(
    invoiceId,
    kase.id,
    "classified",
    classification.fallback ? `Couldn't classify automatically: ${classification.error}` : `Diagnosed ${c.reason.replace("_", " ")} (confidence ${c.confidence.toFixed(2)})`,
    c,
  );

  // Pending proposals from an earlier run are superseded by this one.
  await db.proposedAction.updateMany({ where: { caseId: kase.id, status: "pending" }, data: { status: "rejected", decidedAt: now, result: json({ superseded: true }) } });

  const ctx = gateContext(invoice, kase, now);
  const counter = { n: 0 };
  if (c.reason !== "other") onStage("proposing");
  const tools = buildAgentTools(ctx, hooksFor(kase.id, invoice, c.confidence, counter));
  const proposal =
    c.reason === "other"
      ? { rationale: "", error: undefined }
      : await proposeAction(
          model,
          {
            facts: buildFacts(invoice, ctx, c.promisedDate, now),
            reason: c.reason,
            diagnosis: c.summary,
            clientName: invoice.client.name,
            freelancerName: invoice.client.freelancer.name,
            thread: thread.map((m) => ({ from: m.from, at: ymd(m.at), body: m.body })),
          },
          tools,
          () => counter.n,
        );

  onStage("saving");
  if (counter.n === 0) {
    const why = proposal.error ? `AI could not propose an action: ${proposal.error}` : "No automatic action fits; please review this reply";
    await db.proposedAction.create({
      data: { caseId: kase.id, type: "manual_review", params: json({}), draft: c.summary, confidence: c.confidence, mandateVerdict: "needs_approval", mandateReasons: json([why]) },
    });
    await timeline(invoiceId, kase.id, "manual_review", why);
  } else if (proposal.rationale) {
    await timeline(invoiceId, kase.id, "agent_summary", `Agent's note: ${proposal.rationale}`);
  }
  return kase.id;
}

/** Freelancer approves (optionally editing the draft). The mandate is checked again: approval satisfies
 * needs_approval, never deny, and the invoice may have changed since the proposal. */
export async function approveProposal(proposalId: string, freelancerId: string, editedDraft?: string) {
  const p = await db.proposedAction.findFirst({ where: { id: proposalId, case: { invoice: { client: { freelancerId } } } }, include: { case: true } });
  if (!p) throw new Error("Proposal not found");
  if (p.status !== "pending") throw new Error(`Proposal is already ${p.status}`);
  const invoice = await loadInvoice(p.case.invoiceId, freelancerId);
  const input = { ...(p.params as Record<string, unknown>) };
  const edited = editedDraft !== undefined && editedDraft !== p.draft;
  if (edited) {
    const field = { send_message: "body", send_invoice_reminder: "note", offer_payment_plan: "message", escalate_dispute: "summary" }[p.type];
    if (field) input[field] = editedDraft;
  }
  if (p.type !== "manual_review") {
    const ctx = gateContext(invoice, p.case, new Date());
    const verdict = checkAction(toAction(p.type, input, ctx), ctx.mandate);
    if (verdict.verdict === "deny") {
      await db.proposedAction.update({ where: { id: p.id }, data: { status: "denied", mandateVerdict: "deny", mandateReasons: json(verdict.reasons), decidedAt: new Date() } });
      await timeline(invoice.id, p.caseId, "approval_blocked", `Mandate blocked ${p.type} on approval: ${verdict.reasons.join("; ")}`);
      throw new Error(`Blocked by your mandate: ${verdict.reasons.join("; ")}`);
    }
  }
  try {
    const result = await executeProposal(p.caseId, invoice, { toolName: p.type, input });
    await db.proposedAction.update({ where: { id: p.id }, data: { status: "executed", params: json(input), draft: draftOf(p.type, input), result: json(result), decidedAt: new Date() } });
    await timeline(invoice.id, p.caseId, "action_approved", `You approved ${p.type}${edited ? " (edited)" : ""}`, result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.proposedAction.update({ where: { id: p.id }, data: { status: "failed", result: json({ error: message }), decidedAt: new Date() } });
    await timeline(invoice.id, p.caseId, "action_failed", `${p.type} failed: ${message}`);
    throw e;
  }
}

export async function rejectProposal(proposalId: string, freelancerId: string) {
  const p = await db.proposedAction.findFirst({ where: { id: proposalId, status: "pending", case: { invoice: { client: { freelancerId } } } }, include: { case: true } });
  if (!p) throw new Error("Proposal not found or already decided");
  await db.proposedAction.update({ where: { id: p.id }, data: { status: "rejected", decidedAt: new Date() } });
  await timeline(p.case.invoiceId, p.caseId, "action_rejected", `You rejected ${p.type}`);
}
