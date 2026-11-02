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

/** Pulls the latest status from PayPal. Used by the sync button now and the polling job in M2. */
export async function syncInvoice(invoice: Invoice): Promise<Invoice> {
  if (!invoice.paypalInvoiceId) return invoice;
  const fresh = await getInvoice(invoice.paypalInvoiceId);
  const updated = await db.invoice.update({ where: { id: invoice.id }, data: statusFields(fresh, invoice.currency) });
  if (updated.status !== invoice.status) {
    await db.timelineEvent.create({
      data: { invoiceId: invoice.id, kind: "status_changed", summary: `PayPal status ${invoice.status} → ${updated.status}` },
    });
  }
  return updated;
}
