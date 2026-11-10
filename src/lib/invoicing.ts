// Freelancer-initiated invoice lifecycle (Flow A). Agent-initiated money actions go through
// src/agent instead, where the mandate check sits in front of PayPal.
import { randomBytes } from "node:crypto";
import type { Client, Freelancer, Invoice } from "@/generated/prisma/client";
import { toMinor } from "@/lib/money";
import { createDraftInvoice, getInvoice, heldPaymentReason, sendInvoice, updateDraftInvoice, type LineItem, type PayPalInvoice } from "@/paypal/invoices";
import { invoiceIdOf, WEBHOOK_EVENTS, type WebhookEventBody } from "@/paypal/webhooks";
import { PayPalError, plainPayPalMessage } from "@/paypal/client";
import { supersedePending } from "@/agent/supersede";
import { db } from "./db";

export const newPayToken = () => randomBytes(24).toString("base64url");

export const lineTotal = (items: LineItem[]) =>
  items.reduce((sum, i) => sum + Math.round(i.quantity * i.unitAmountMinor), 0);

function statusFields(p: PayPalInvoice, currency: string) {
  return {
    status: p.status,
    invoiceNumber: p.detail.invoice_number ?? null,
    ...(p.amount && { totalMinor: toMinor(p.amount.value, currency) }),
    paidMinor: p.payments?.paid_amount ? toMinor(p.payments.paid_amount.value, currency) : 0,
    ...(p.detail.metadata?.recipient_view_url && { payerViewUrl: p.detail.metadata.recipient_view_url }),
    lastSyncedAt: new Date(),
  };
}

export interface NewInvoice {
  freelancer: Freelancer;
  client: Client;
  projectId?: string;
  items: LineItem[];
  dueDate: Date;
  invoiceDate?: Date;
  note?: string;
}

const draftInput = (freelancer: Freelancer, client: Client, invoice: Pick<Invoice, "items" | "dueDate" | "issueDate" | "note">) => ({
  currency: client.currency,
  invoicerBusinessName: freelancer.businessName,
  recipientEmail: client.email,
  recipientName: client.name,
  items: invoice.items as unknown as LineItem[],
  dueDate: invoice.dueDate,
  invoiceDate: invoice.issueDate,
  note: invoice.note ?? undefined,
});

const paypalError = (invoiceId: string, e: unknown) =>
  db.timelineEvent.create({
    data: { invoiceId, kind: "paypal_error", summary: plainPayPalMessage(e), ...(e instanceof PayPalError && { data: { status: e.status, name: e.paypalName ?? null, debugId: e.debugId ?? null } }) },
  });

/** Creates the PayPal draft if needed, sends it and stores the result. A failure after the PayPal draft exists keeps
 * the local row (with a paypal_error timeline entry) so it can be retried. */
export async function sendDraft(invoice: Invoice, freelancer: Freelancer, client: Client): Promise<Invoice> {
  let paypalId = invoice.paypalInvoiceId;
  try {
    if (!paypalId) {
      paypalId = (await createDraftInvoice(draftInput(freelancer, client, invoice))).id;
      await db.invoice.update({ where: { id: invoice.id }, data: { paypalInvoiceId: paypalId } });
    }
    const { payerViewUrl } = await sendInvoice(paypalId);
    const fresh = await getInvoice(paypalId);
    const updated = await db.invoice.update({
      where: { id: invoice.id },
      data: { ...statusFields(fresh, client.currency), ...(payerViewUrl && !fresh.detail.metadata?.recipient_view_url && { payerViewUrl }) },
    });
    await db.timelineEvent.create({
      data: { invoiceId: invoice.id, kind: "invoice_sent", summary: `Invoice sent through PayPal (${fresh.status})`, data: { paypalInvoiceId: paypalId } },
    });
    return updated;
  } catch (e) {
    if (paypalId) await paypalError(invoice.id, e);
    throw e;
  }
}

/** Saves the invoice locally, then creates and sends it on PayPal. Rethrows PayPal failures. */
export async function createAndSendInvoice(input: NewInvoice): Promise<Invoice> {
  const { freelancer, client, items } = input;
  if (!items.length) throw new Error("An invoice needs at least one line item");
  const invoice = await db.invoice.create({
    data: {
      clientId: client.id,
      projectId: input.projectId,
      currency: client.currency,
      totalMinor: lineTotal(items),
      issueDate: input.invoiceDate ?? new Date(),
      dueDate: input.dueDate,
      items: items as object[],
      note: input.note,
      payToken: newPayToken(),
    },
  });
  try {
    return await sendDraft(invoice, freelancer, client);
  } catch (e) {
    // Nothing exists on PayPal yet: drop the local row so a retry doesn't leave duplicates.
    const row = await db.invoice.findUnique({ where: { id: invoice.id } });
    if (!row?.paypalInvoiceId) await db.invoice.delete({ where: { id: invoice.id } });
    throw e;
  }
}

/** Flow B: adds a billable line to the project's open draft, or starts a new one due in 14 days. Saved locally first;
 * the PayPal draft is then created or updated, and a PayPal failure is reported without losing the line. */
export async function addLineToDraft(freelancer: Freelancer, client: Client, projectId: string, item: LineItem) {
  const existing = await db.invoice.findFirst({ where: { projectId, status: "DRAFT", planGroupId: null }, orderBy: { createdAt: "desc" } });
  const items = [...((existing?.items as unknown as LineItem[] | undefined) ?? []), item];
  const data = { items: items as object[], totalMinor: lineTotal(items) };
  const invoice = existing
    ? await db.invoice.update({ where: { id: existing.id }, data })
    : await db.invoice.create({ data: { ...data, clientId: client.id, projectId, currency: client.currency, dueDate: new Date(Date.now() + 14 * 86_400_000), payToken: newPayToken() } });
  await db.timelineEvent.create({ data: { invoiceId: invoice.id, kind: "line_added", summary: `Added "${item.name}" from a scope check` } });
  try {
    if (invoice.paypalInvoiceId) await updateDraftInvoice(invoice.paypalInvoiceId, draftInput(freelancer, client, invoice));
    else {
      const draft = await createDraftInvoice(draftInput(freelancer, client, invoice));
      await db.invoice.update({ where: { id: invoice.id }, data: { paypalInvoiceId: draft.id } });
    }
    return { invoiceId: invoice.id };
  } catch (e) {
    await paypalError(invoice.id, e);
    return { invoiceId: invoice.id, warning: `Saved as a local draft; PayPal draft not updated: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const PAID = ["PAID", "MARKED_AS_PAID"];
const REFUNDED = ["REFUNDED", "PARTIALLY_REFUNDED", "MARKED_AS_REFUNDED"];
export const CLOSED = [...PAID, "CANCELLED", ...REFUNDED];
const HELD = "PAYMENT_PENDING";

/** PayPal's reason codes for a held payment, as a sentence. The codes come from the payment's status_details. */
const HOLD_REASON: Record<string, string> = {
  RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION: "PayPal is waiting for the receiving PayPal account to accept it: that account's payment preferences need someone to accept each payment (for example one in a currency the account doesn't hold). Open the payment in the business account's Activity and accept it.",
  PENDING_REVIEW: "PayPal is reviewing the payment.",
  VERIFICATION_REQUIRED: "PayPal needs the receiving account to be verified before it releases the payment.",
  ECHECK: "The payment is an eCheck and is waiting to clear.",
  INTERNATIONAL_WITHDRAWAL: "PayPal needs the receiving account to accept or deny the payment in its account overview.",
  TRANSACTION_APPROVED_AWAITING_FUNDING: "The client's funds are still being collected.",
};

/** What the freelancer reads when PayPal starts or stops holding a client's payment (not when it simply completes: that
 * is closureNote's "paid"). `reason` is PayPal's code for the hold, when it could be read. */
export function heldNote(prev: string, next: string, reason: string | null): { kind: string; summary: string; data?: object } | null {
  if (prev === next) return null;
  if (next === HELD) {
    const why = reason ? (HOLD_REASON[reason] ?? `PayPal's reason: ${reason.replaceAll("_", " ").toLowerCase()}.`) : "PayPal didn't say why.";
    return { kind: "payment_held", summary: `Payment received, held by PayPal. ${why} The agent is paused on this invoice (no reminders, no rescheduling) until PayPal completes it.`, data: { reason } };
  }
  if (prev === HELD && !CLOSED.includes(next)) return { kind: "payment_released", summary: "PayPal did not complete the held payment, so the invoice is unpaid again. The agent can act on it again." };
  return null;
}

/** What the freelancer reads when an invoice closes. `source` says who noticed: our own plan flow cancels the original
 * itself, so that one gets no "in PayPal" note; webhooks and polling mean it happened outside ClearDue. */
export function closureNote(prev: string, next: string, source: string): { kind: string; summary: string } | null {
  if (prev === next || !CLOSED.includes(next) || source === "plan") return null;
  const outside = /webhook|polling/.test(source);
  if (REFUNDED.includes(next)) {
    return { kind: "paypal_refunded", summary: `${next === "PARTIALLY_REFUNDED" ? "Partly refunded" : "Refunded"} in PayPal, agent paused. No more reminders, plans or messages on this invoice.` };
  }
  if (next === "CANCELLED") return { kind: "paypal_cancelled", summary: "Cancelled in PayPal, agent stopped. It will not remind, reschedule or split this invoice." };
  if (PAID.includes(prev)) return null;
  if (prev === HELD) return { kind: "paypal_paid", summary: "Payment cleared: PayPal released the held payment. Paid, reminders stopped." };
  return { kind: "paypal_paid", summary: outside ? "Paid in PayPal outside ClearDue, reminders stopped." : "Paid, reminders stopped." };
}

/** Pulls the latest status from PayPal (sync button, webhooks, polling). PayPal is the source of truth:
 * webhook payloads only tell us *which* invoice to re-read. A closed invoice resolves its case and supersedes anything
 * the agent was still waiting to do. */
export async function syncInvoice(invoice: Invoice, source = "sync"): Promise<Invoice> {
  if (!invoice.paypalInvoiceId) return invoice;
  const fresh = await getInvoice(invoice.paypalInvoiceId);
  const updated = await db.invoice.update({ where: { id: invoice.id }, data: statusFields(fresh, invoice.currency) });
  if (updated.status === invoice.status) return updated;
  const closed = CLOSED.includes(updated.status);
  if (closed) await db.task.updateMany({ where: { invoiceId: invoice.id, done: false }, data: { done: true } });
  const kase = await db.case.findUnique({ where: { invoiceId: invoice.id } });
  await db.timelineEvent.create({
    data: { invoiceId: invoice.id, caseId: kase?.id, kind: "status_changed", summary: `PayPal status ${invoice.status} → ${updated.status} (${source})` },
  });
  const note = closureNote(invoice.status, updated.status, source);
  if (note) await db.timelineEvent.create({ data: { invoiceId: invoice.id, caseId: kase?.id, ...note } });
  const held = heldNote(invoice.status, updated.status, updated.status === HELD ? await heldPaymentReason(fresh) : null);
  if (held) await db.timelineEvent.create({ data: { invoiceId: invoice.id, caseId: kase?.id, ...held } });
  // The client has paid: anything the agent was waiting to ask (a reminder, a plan offer) is moot while PayPal holds it.
  if (kase && updated.status === HELD) await supersedePending(kase.id, invoice.id, "the client's payment is held by PayPal");
  if (kase && closed) {
    // A refund after payment finds the case already resolved; anything still pending is superseded either way.
    await supersedePending(kase.id, invoice.id, `the invoice is now ${updated.status.replaceAll("_", " ").toLowerCase()}`);
    if (kase.state !== "resolved") {
      await db.case.update({ where: { id: kase.id }, data: { state: "resolved", pausedUntil: null } });
      await db.timelineEvent.create({
        data: { invoiceId: invoice.id, caseId: kase.id, kind: "case_resolved", summary: `Case closed: invoice is ${updated.status.replaceAll("_", " ").toLowerCase()}` },
      });
    }
  }
  if (updated.planGroupId && (updated.status === "CANCELLED" || REFUNDED.includes(updated.status)) && source !== "plan") await planPartClosed(updated);
  return updated;
}

/** A plan part was cancelled or refunded in PayPal: the plan as agreed no longer holds, so the parent plan is marked
 * interrupted and the freelancer is told on the original invoice. The other parts are left as they are. */
async function planPartClosed(part: Invoice) {
  const group = await db.planGroup.findUnique({ where: { id: part.planGroupId! }, include: { invoices: { orderBy: { dueDate: "asc" }, select: { id: true } } } });
  if (!group) return;
  const n = group.invoices.findIndex((i) => i.id === part.id) + 1;
  const what = part.status === "CANCELLED" ? "cancelled" : "refunded";
  const error = `Part ${n} of ${group.invoices.length}${part.invoiceNumber ? ` (${part.invoiceNumber})` : ""} was ${what} in PayPal`;
  await db.planGroup.update({ where: { id: group.id }, data: { state: "interrupted", error } });
  const kase = await db.case.findUnique({ where: { invoiceId: group.originalInvoiceId } });
  if (kase) await supersedePending(kase.id, group.originalInvoiceId, error.toLowerCase());
  await db.timelineEvent.create({
    data: { invoiceId: group.originalInvoiceId, caseId: kase?.id, kind: "plan_interrupted", summary: `${error}. The payment plan is interrupted; the other parts stay as they are. Check with the client before re-planning.` },
  });
}

/** Stores a webhook event and, if it may be processed, syncs the invoice it names. Shared by the webhook route and the
 * mock-mode "Simulate client payment" button. Idempotent by event id; returns false if the sync failed (left unprocessed). */
export async function handleWebhookEvent(event: WebhookEventBody, opts: { verified: boolean; process: boolean; note: string | null; source: string }) {
  const payload = JSON.parse(JSON.stringify(event));
  await db.webhookEvent.upsert({
    where: { id: event.id },
    create: { id: event.id, eventType: event.event_type, resourceId: invoiceIdOf(event), verified: opts.verified, note: opts.note, payload },
    update: { verified: opts.verified, note: opts.note },
  });
  if (!opts.process) return false;
  if (!WEBHOOK_EVENTS.includes(event.event_type)) console.log(`[webhook] ignoring event type ${event.event_type} (${event.id}); stored, nothing to do`);
  else {
    const paypalId = invoiceIdOf(event);
    const invoice = paypalId ? await db.invoice.findUnique({ where: { paypalInvoiceId: paypalId } }) : null;
    if (invoice) {
      try {
        await syncInvoice(invoice, `${opts.source} ${event.event_type}`);
      } catch (e) {
        console.error("webhook sync failed", e);
        return false;
      }
    }
  }
  await db.webhookEvent.update({ where: { id: event.id }, data: { processed: true } });
  return true;
}

/** Polling fallback for unreliable webhooks: re-reads open invoices not synced recently, and ends expired pauses. */
export async function syncStale(maxAgeMs = 2 * 60_000, limit = 50) {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const invoices = await db.invoice.findMany({
    where: { paypalInvoiceId: { not: null }, status: { notIn: [...CLOSED, "DRAFT"] }, OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: cutoff } }] },
    orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } },
    take: limit,
  });
  const errors: string[] = [];
  for (const inv of invoices) {
    try {
      await syncInvoice(inv, "polling");
    } catch (e) {
      errors.push(`${inv.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Refunds land on invoices that are already paid, which the query above skips. Re-read recently paid ones at a slower
  // pace (PayPal allows refunds for 180 days).
  const paidCutoff = new Date(Date.now() - 30 * 60_000);
  const paid = await db.invoice.findMany({
    where: { paypalInvoiceId: { not: null }, status: { in: [...PAID, "PARTIALLY_REFUNDED"] }, createdAt: { gt: new Date(Date.now() - 180 * 86_400_000) }, OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: paidCutoff } }] },
    orderBy: { lastSyncedAt: { sort: "asc", nulls: "first" } },
    take: 20,
  });
  for (const inv of paid) {
    try {
      await syncInvoice(inv, "polling");
    } catch (e) {
      errors.push(`${inv.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Verified webhook deliveries whose sync failed (the route acknowledges first, so PayPal won't resend them).
  const unprocessed = await db.webhookEvent.findMany({ where: { verified: true, processed: false, receivedAt: { gt: new Date(Date.now() - 3 * 86_400_000) } }, take: 20 });
  let replayed = 0;
  for (const e of unprocessed) {
    const event = e.payload as unknown as WebhookEventBody;
    if (await handleWebhookEvent(event, { verified: true, process: true, note: e.note, source: "polling retry of webhook" })) replayed++;
  }
  const expired = await db.case.findMany({ where: { state: "paused", pausedUntil: { lte: new Date() } } });
  for (const c of expired) {
    await db.case.update({ where: { id: c.id }, data: { state: "open", pausedUntil: null } });
    await db.timelineEvent.create({ data: { invoiceId: c.invoiceId, caseId: c.id, kind: "pause_ended", summary: "Pause ended; the case is open again" } });
  }
  return { synced: invoices.length + paid.length - errors.length, errors, webhooksRetried: replayed, pausesEnded: expired.length };
}
