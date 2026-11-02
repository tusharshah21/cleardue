// Freelancer-initiated invoice lifecycle (Flow A). Agent-initiated money actions go through
// src/agent instead, where the mandate check sits in front of PayPal.
import { randomBytes } from "node:crypto";
import type { Client, Freelancer, Invoice } from "@/generated/prisma/client";
import { toMinor } from "@/lib/money";
import { createDraftInvoice, getInvoice, sendInvoice, type LineItem, type PayPalInvoice } from "@/paypal/invoices";
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

/** Saves the invoice locally, then creates and sends it on PayPal. Rethrows PayPal failures; a failure after the
 * PayPal draft exists keeps the local row (with a paypal_error timeline entry) so it can be retried. */
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
  let paypalId: string | undefined;
  try {
    const draft = await createDraftInvoice({
      currency: client.currency,
      invoicerBusinessName: freelancer.businessName,
      recipientEmail: client.email,
      recipientName: client.name,
      items,
      dueDate: input.dueDate,
      invoiceDate: input.invoiceDate,
      note: input.note,
    });
    paypalId = draft.id;
    await db.invoice.update({ where: { id: invoice.id }, data: { paypalInvoiceId: draft.id } });
    const { payerViewUrl } = await sendInvoice(draft.id);
    const fresh = await getInvoice(draft.id);
    const updated = await db.invoice.update({
      where: { id: invoice.id },
      data: { ...statusFields(fresh, client.currency), ...(payerViewUrl && !fresh.detail.metadata?.recipient_view_url && { payerViewUrl }) },
    });
    await db.timelineEvent.create({
      data: { invoiceId: invoice.id, kind: "invoice_sent", summary: `Invoice sent through PayPal (${fresh.status})`, data: { paypalInvoiceId: draft.id } },
    });
    return updated;
  } catch (e) {
    // Nothing exists on PayPal yet: drop the local row so a retry doesn't leave duplicates.
    if (!paypalId) {
      await db.invoice.delete({ where: { id: invoice.id } });
      throw e;
    }
    const message = e instanceof Error ? e.message : String(e);
    await db.timelineEvent.create({ data: { invoiceId: invoice.id, kind: "paypal_error", summary: message } });
    throw e;
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
