// PayPal Invoicing API v2. Every money-affecting call here must be reached through the
// mandate check (src/agent), never directly from AI output.
import { fromMinor } from "@/lib/money";
import { paypalRequest } from "./client";

const BASE = "/v2/invoicing/invoices";

export interface LineItem {
  name: string;
  description?: string;
  quantity: number;
  unitAmountMinor: number;
  unit: "HOURS" | "AMOUNT";
}

export interface CreateInvoiceInput {
  currency: string;
  invoicerBusinessName: string;
  recipientEmail: string;
  recipientName: string;
  items: LineItem[];
  dueDate: Date;
  invoiceDate?: Date;
  note?: string;
  term?: string;
  allowTip?: boolean;
  /** Only valid when the invoicer's country supports partial payments (not IN, BR, IL). */
  partialPayment?: { minimumAmountDueMinor: number };
}

export interface PayPalInvoice {
  id: string;
  status: string;
  detail: {
    invoice_number?: string;
    currency_code: string;
    metadata?: { recipient_view_url?: string; invoicer_view_url?: string };
  };
  amount?: { currency_code: string; value: string };
  due_amount?: { currency_code: string; value: string };
  payments?: { paid_amount?: { currency_code: string; value: string } };
}

interface LinkDescription {
  href: string;
  rel: string;
  method?: string;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export function buildInvoiceBody(input: CreateInvoiceInput) {
  const { currency } = input;
  return {
    detail: {
      currency_code: currency,
      invoice_date: isoDate(input.invoiceDate ?? new Date()),
      payment_term: { term_type: "DUE_ON_DATE_SPECIFIED", due_date: isoDate(input.dueDate) },
      ...(input.note && { note: input.note }),
      ...(input.term && { term: input.term }),
    },
    invoicer: { business_name: input.invoicerBusinessName },
    primary_recipients: [
      { billing_info: { business_name: input.recipientName, email_address: input.recipientEmail } },
    ],
    items: input.items.map((i) => ({
      name: i.name,
      ...(i.description && { description: i.description }),
      quantity: String(i.quantity),
      unit_amount: { currency_code: currency, value: fromMinor(i.unitAmountMinor, currency) },
      unit_of_measure: i.unit,
    })),
    configuration: {
      allow_tip: input.allowTip ?? false,
      ...(input.partialPayment && {
        partial_payment: {
          allow_partial_payment: true,
          minimum_amount_due: {
            currency_code: currency,
            value: fromMinor(input.partialPayment.minimumAmountDueMinor, currency),
          },
        },
      }),
    },
  };
}

export function createDraftInvoice(input: CreateInvoiceInput) {
  return paypalRequest<PayPalInvoice>(BASE, {
    method: "POST",
    body: buildInvoiceBody(input),
    headers: { Prefer: "return=representation" },
  });
}

/** Full update of a draft (PayPal replaces the whole invoice). */
export function updateDraftInvoice(id: string, input: CreateInvoiceInput) {
  return paypalRequest<PayPalInvoice>(`${BASE}/${encodeURIComponent(id)}?send_to_recipient=false&send_to_invoicer=false`, {
    method: "PUT",
    body: { id, ...buildInvoiceBody(input) },
    headers: { Prefer: "return=representation" },
  });
}

export function getInvoice(id: string) {
  return paypalRequest<PayPalInvoice>(`${BASE}/${encodeURIComponent(id)}`);
}

/** Sends a draft. PayPal emails the recipient (sandbox: visible under Sandbox > Notifications). */
export async function sendInvoice(id: string, opts: { subject?: string; note?: string } = {}) {
  const res = await paypalRequest<LinkDescription & { links?: LinkDescription[] }>(
    `${BASE}/${encodeURIComponent(id)}/send`,
    { method: "POST", body: { send_to_invoicer: false, send_to_recipient: true, ...opts } },
  );
  return { payerViewUrl: res?.links?.find((l) => l.rel === "payer-view")?.href ?? res?.href };
}

export function remindInvoice(id: string, opts: { subject?: string; note?: string; additionalRecipients?: string[] } = {}) {
  return paypalRequest<void>(`${BASE}/${encodeURIComponent(id)}/remind`, {
    method: "POST",
    body: {
      send_to_invoicer: false,
      ...(opts.subject && { subject: opts.subject }),
      ...(opts.note && { note: opts.note }),
      ...(opts.additionalRecipients?.length && { additional_recipients: opts.additionalRecipients }),
    },
  });
}

export function cancelInvoice(id: string, opts: { sendToRecipient: boolean; note?: string }) {
  return paypalRequest<void>(`${BASE}/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: { send_to_recipient: opts.sendToRecipient, send_to_invoicer: false, ...(opts.note && { note: opts.note }) },
  });
}

export function deleteDraftInvoice(id: string) {
  return paypalRequest<void>(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });
}
