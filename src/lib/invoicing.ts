// Freelancer-initiated invoice lifecycle (Flow A). Agent-initiated money actions go through
// src/agent instead, where the mandate check sits in front of PayPal.
import { randomBytes } from "node:crypto";
import type { Client, Freelancer, Invoice } from "@/generated/prisma/client";
import { toMinor } from "@/lib/money";
import { createDraftInvoice, getInvoice, sendInvoice, updateDraftInvoice, type LineItem, type PayPalInvoice } from "@/paypal/invoices";
import { INVOICE_EVENTS, invoiceIdOf, type WebhookEventBody } from "@/paypal/webhooks";
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
  db.timelineEvent.create({ data: { invoiceId, kind: "paypal_error", summary: e instanceof Error ? e.message : String(e) } });

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

const CLOSED = ["PAID", "MARKED_AS_PAID", "CANCELLED", "REFUNDED", "MARKED_AS_REFUNDED"];

/** Pulls the latest status from PayPal (sync button, webhooks, polling). PayPal is the source of truth:
 * webhook payloads only tell us *which* invoice to re-read. A closed invoice resolves its case. */
export async function syncInvoice(invoice: Invoice, source = "sync"): Promise<Invoice> {
  if (!invoice.paypalInvoiceId) return invoice;
  const fresh = await getInvoice(invoice.paypalInvoiceId);
  const updated = await db.invoice.update({ where: { id: invoice.id }, data: statusFields(fresh, invoice.currency) });
  if (updated.status === invoice.status) return updated;
  if (CLOSED.includes(updated.status)) await db.task.updateMany({ where: { invoiceId: invoice.id, done: false }, data: { done: true } });
  const kase = await db.case.findUnique({ where: { invoiceId: invoice.id } });
  await db.timelineEvent.create({
    data: { invoiceId: invoice.id, caseId: kase?.id, kind: "status_changed", summary: `PayPal status ${invoice.status} → ${updated.status} (${source})` },
  });
  if (kase && CLOSED.includes(updated.status) && kase.state !== "resolved") {
    await db.case.update({ where: { id: kase.id }, data: { state: "resolved", pausedUntil: null } });
    await db.proposedAction.updateMany({ where: { caseId: kase.id, status: "pending" }, data: { status: "rejected", decidedAt: new Date(), result: { superseded: `invoice ${updated.status}` } } });
    await db.timelineEvent.create({
      data: { invoiceId: invoice.id, caseId: kase.id, kind: "case_resolved", summary: `Case closed: invoice is ${updated.status.replaceAll("_", " ").toLowerCase()}` },
    });
  }
  return updated;
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
  if (INVOICE_EVENTS.includes(event.event_type)) {
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
  const expired = await db.case.findMany({ where: { state: "paused", pausedUntil: { lte: new Date() } } });
  for (const c of expired) {
    await db.case.update({ where: { id: c.id }, data: { state: "open", pausedUntil: null } });
    await db.timelineEvent.create({ data: { invoiceId: c.invoiceId, caseId: c.id, kind: "pause_ended", summary: "Pause ended; the case is open again" } });
  }
  return { synced: invoices.length - errors.length, errors, pausesEnded: expired.length };
}
