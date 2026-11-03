// Flow D: the client's pay page. Questions are answered from the scope, invoice and thread only; anything the
// assistant can't ground becomes a task for the freelancer, and a complaint moves the case to dispute.
import type { LanguageModel } from "ai";
import { cacheScopeFor } from "@/ai/cache";
import { getModel } from "@/ai/provider";
import { payerAssistant, type PayerSources } from "@/ai/tasks";
import { db } from "@/lib/db";
import { fromMinor } from "@/lib/money";
import { isOpen } from "@/lib/receivables";
import type { LineItem } from "@/paypal/invoices";
import { planOptions } from "@/plans/accept";
import type { Instalment } from "./mandate";

export async function loadPayInvoice(payToken: string) {
  return db.invoice.findUnique({
    where: { payToken },
    include: {
      client: { include: { freelancer: true } },
      project: true,
      messages: { orderBy: { sentAt: "asc" } },
      payerQuestions: { orderBy: { createdAt: "asc" } },
      case: true,
    },
  });
}
type PayInvoice = NonNullable<Awaited<ReturnType<typeof loadPayInvoice>>>;

/** The assistant's sources. INVOICE also carries figures computed by code (outstanding, paid, plan options), so the
 * figure check accepts them and "how much do I still owe?" gets an answer. */
export function payerSources(invoice: PayInvoice, plans: Instalment[][] = []): PayerSources {
  const c = invoice.currency;
  const amount = (minor: number) => `${c} ${fromMinor(minor, c)}`;
  const lines = (invoice.items as unknown as LineItem[]).map(
    (i) => `${i.name}: ${i.quantity} x ${c} ${fromMinor(i.unitAmountMinor, c)} = ${c} ${fromMinor(Math.round(i.quantity * i.unitAmountMinor), c)}${i.description ? ` (${i.description})` : ""}`,
  );
  return {
    scope: invoice.project?.scope ?? "",
    invoice: [
      `Invoice ${invoice.invoiceNumber ?? "(draft)"} from ${invoice.client.freelancer.businessName} to ${invoice.client.name}`,
      ...lines,
      `Total: ${c} ${fromMinor(invoice.totalMinor, c)}. Paid so far: ${c} ${fromMinor(invoice.paidMinor, c)}. Due date: ${invoice.dueDate.toISOString().slice(0, 10)}. Status: ${invoice.status}.`,
      `Amount outstanding: ${amount(isOpen(invoice) ? invoice.totalMinor - invoice.paidMinor : 0)}. Amount paid: ${amount(invoice.paidMinor)}.`,
      ...plans.map((p, i) => `Payment plan option ${i + 1}: ${p.map((x) => `${amount(x.amountMinor)} by ${x.dueDate.toISOString().slice(0, 10)}`).join(", then ")}.`),
      ...(invoice.note ? [`Note: ${invoice.note}`] : []),
    ].join("\n"),
    thread: invoice.messages
      .filter((m) => m.channel !== "pay_page")
      .map((m) => `[${m.sentAt.toISOString().slice(0, 10)}] ${m.direction === "INBOUND" ? invoice.client.name : invoice.client.freelancer.name}: ${m.body}`)
      .join("\n"),
  };
}

export async function askPayer(payToken: string, question: string, model: LanguageModel = getModel()) {
  const invoice = await loadPayInvoice(payToken);
  if (!invoice) throw new Error("Invoice not found");
  const freelancerName = invoice.client.freelancer.name;
  const open = isOpen(invoice);
  const { value, replayed = false, cached = false } = await payerAssistant(model, {
    freelancerName,
    sources: payerSources(invoice, open ? await planOptions(invoice) : []),
    question,
    cacheScope: await cacheScopeFor(invoice.client.freelancer),
  });
  let a = value;

  const saved = await db.payerQuestion.create({
    data: { invoiceId: invoice.id, question, answer: a.answer, citations: a.citations, escalated: a.escalate || a.complaint, wantsPlan: a.wantsPlan, replayed, cached },
  });
  // The question joins the thread, so the agent's next diagnosis sees it too.
  await db.message.create({ data: { clientId: invoice.clientId, invoiceId: invoice.id, direction: "INBOUND", channel: "pay_page", fromAddr: invoice.client.email, body: question } });

  // Asking for a plan unlocks the plan options (within the mandate). If there are any, point to them instead of escalating.
  let plansAvailable = false;
  if (a.wantsPlan && !a.complaint && open) {
    plansAvailable = (await planOptions(invoice)).length > 0;
    if (plansAvailable) {
      a = { ...a, answer: `Yes, ${freelancerName} allows paying in parts. The plan options are now shown on this page; pick one and PayPal will send the new invoice(s).`, citations: [], escalate: false };
      await db.payerQuestion.update({ where: { id: saved.id }, data: { answer: a.answer, citations: [], escalated: false } });
    }
  }

  if (a.complaint) {
    const kase = await db.case.upsert({
      where: { invoiceId: invoice.id },
      create: { invoiceId: invoice.id, reason: "dispute", state: "dispute", summary: "The client raised a complaint on the pay page." },
      update: { state: "dispute", reason: "dispute", pausedUntil: null },
    });
    await db.proposedAction.updateMany({ where: { caseId: kase.id, status: "pending" }, data: { status: "rejected", decidedAt: new Date(), result: { superseded: "complaint on pay page" } } });
    await db.task.create({ data: { invoiceId: invoice.id, kind: "complaint", summary: "Client complaint on the pay page; automation stopped", detail: question } });
    await db.timelineEvent.create({ data: { invoiceId: invoice.id, caseId: kase.id, kind: "dispute_opened", summary: "Complaint on the pay page: case moved to dispute, automation stopped" } });
  } else if (a.escalate) {
    await db.task.create({ data: { invoiceId: invoice.id, kind: "escalation", summary: `Pay-page question needs you: ${a.escalationReason ?? "not covered by the sources"}`, detail: question } });
    await db.timelineEvent.create({ data: { invoiceId: invoice.id, kind: "payer_escalated", summary: "Pay-page question escalated to you" } });
  } else if (plansAvailable) {
    await db.timelineEvent.create({ data: { invoiceId: invoice.id, kind: "plan_requested", summary: "Client asked to pay in parts on the pay page; plan options shown" } });
  } else {
    await db.timelineEvent.create({ data: { invoiceId: invoice.id, kind: "payer_answered", summary: `Pay-page assistant answered with ${a.citations.length} citation(s)` } });
  }
  return { id: saved.id, answer: a.answer, citations: a.citations, escalated: a.escalate || a.complaint, replayed, cached, plansAvailable };
}
