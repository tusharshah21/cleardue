// Flow D: the client's pay page. Questions are answered from the scope, invoice and thread only; anything the
// assistant can't ground becomes a task for the freelancer, and a complaint moves the case to dispute.
import type { LanguageModel } from "ai";
import { getModel } from "@/ai/provider";
import { payerAssistant, type PayerSources } from "@/ai/tasks";
import { db } from "@/lib/db";
import { fromMinor } from "@/lib/money";
import type { LineItem } from "@/paypal/invoices";

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

export function payerSources(invoice: PayInvoice): PayerSources {
  const c = invoice.currency;
  const lines = (invoice.items as unknown as LineItem[]).map(
    (i) => `${i.name}: ${i.quantity} x ${c} ${fromMinor(i.unitAmountMinor, c)} = ${c} ${fromMinor(Math.round(i.quantity * i.unitAmountMinor), c)}${i.description ? ` (${i.description})` : ""}`,
  );
  return {
    scope: invoice.project?.scope ?? "",
    invoice: [
      `Invoice ${invoice.invoiceNumber ?? "(draft)"} from ${invoice.client.freelancer.businessName} to ${invoice.client.name}`,
      ...lines,
      `Total: ${c} ${fromMinor(invoice.totalMinor, c)}. Paid so far: ${c} ${fromMinor(invoice.paidMinor, c)}. Due date: ${invoice.dueDate.toISOString().slice(0, 10)}. Status: ${invoice.status}.`,
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
  const { value: a } = await payerAssistant(model, { freelancerName, sources: payerSources(invoice), question });

  const saved = await db.payerQuestion.create({ data: { invoiceId: invoice.id, question, answer: a.answer, citations: a.citations, escalated: a.escalate || a.complaint } });
  // The question joins the thread, so the agent's next diagnosis sees it too.
  await db.message.create({ data: { clientId: invoice.clientId, invoiceId: invoice.id, direction: "INBOUND", channel: "pay_page", fromAddr: invoice.client.email, body: question } });

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
  } else {
    await db.timelineEvent.create({ data: { invoiceId: invoice.id, kind: "payer_answered", summary: `Pay-page assistant answered with ${a.citations.length} citation(s)` } });
  }
  return { id: saved.id, answer: a.answer, citations: a.citations, escalated: a.escalate || a.complaint };
}
