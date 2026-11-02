// Payment plans: two strategies behind one pipeline. PayPal doesn't allow partial payments for invoicers in
// IN, BR or IL, so those freelancers get split_invoices (one invoice per instalment); everyone else can use
// partial_payment (one invoice that accepts part payments). Both replace the original invoice the same way:
// drafts first, re-check the original, cancel it silently, then send. Pure apart from the injected I/O.
import type { Instalment, Mandate } from "@/agent/mandate";
import { formatMoney, splitEvenly } from "@/lib/money";
import type { CreateInvoiceInput, LineItem, PayPalInvoice } from "@/paypal/invoices";

export type PlanStrategy = "split_invoices" | "partial_payment";

const NO_PARTIAL_PAYMENT = ["IN", "BR", "IL"];
export const strategyFor = (country: string): PlanStrategy =>
  NO_PARTIAL_PAYMENT.includes(country.toUpperCase()) ? "split_invoices" : "partial_payment";

const DAY = 86_400_000;
const utcDay = (d: Date) => new Date(Math.floor(d.getTime() / DAY) * DAY);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** A deterministic n-part plan inside the mandate: the first part meets the minimum first payment, the rest
 * split evenly, dates spread from today to at most 30 days apart and never past the latest final date.
 * Returns null when the mandate can't fit n parts. */
export function suggestPlan(outstandingMinor: number, mandate: Mandate, originalDue: Date, now: Date, n: number): Instalment[] | null {
  if (n < 2 || n > mandate.maxInstalments || outstandingMinor < n) return null;
  const min = mandate.minFirstPayment;
  const minFirst = min.kind === "percent" ? Math.ceil((outstandingMinor * min.value) / 100) : min.valueMinor;
  const even = splitEvenly(outstandingMinor, n);
  const first = Math.max(even[0], minFirst);
  if (outstandingMinor - first < n - 1) return null;
  const amounts = [first, ...splitEvenly(outstandingMinor - first, n - 1)];

  const start = utcDay(now).getTime();
  const latest = utcDay(new Date(originalDue.getTime() + mandate.maxPlanDays * DAY)).getTime();
  const span = Math.min((n - 1) * 30, Math.floor((latest - start) / DAY));
  if (span < n - 1) return null;
  return amounts.map((amountMinor, i) => ({ amountMinor, dueDate: new Date(start + Math.round((span * i) / (n - 1)) * DAY) }));
}

/** Which plans the pay page may offer: the plan the freelancer approved, else suggestions inside the mandate, but only
 * when the client needs one (diagnosed cash_constraint, or they asked for a plan in the pay-page chat). Never by default. */
export function planOffers(o: {
  approved: Instalment[] | null;
  reason: string | null;
  askedForPlan: boolean;
  outstandingMinor: number;
  mandate: Mandate;
  originalDue: Date;
  now: Date;
}): Instalment[][] {
  if (o.approved) return [o.approved];
  if (o.reason !== "cash_constraint" && !o.askedForPlan) return [];
  const plans: Instalment[][] = [];
  for (let n = 2; n <= o.mandate.maxInstalments; n++) {
    const plan = suggestPlan(o.outstandingMinor, o.mandate, o.originalDue, o.now, n);
    if (plan) plans.push(plan);
  }
  return plans;
}

export interface PlanOriginal {
  currency: string;
  invoiceNumber: string | null;
  items: LineItem[];
  totalMinor: number;
  paidMinor: number;
}

export interface PlanParties {
  invoicerBusinessName: string;
  recipientEmail: string;
  recipientName: string;
}

const scheduleText = (plan: Instalment[], currency: string) =>
  plan.map((p, i) => `${i + 1}. ${formatMoney(p.amountMinor, currency)} by ${ymd(p.dueDate)}`).join("; ");

/** The replacement invoices for a plan. Throws unless the instalments add up to exactly what is owed. */
export function replacementDrafts(strategy: PlanStrategy, original: PlanOriginal, plan: Instalment[], parties: PlanParties): CreateInvoiceInput[] {
  const outstanding = original.totalMinor - original.paidMinor;
  const sum = plan.reduce((s, p) => s + p.amountMinor, 0);
  if (original.paidMinor > 0) throw new Error("Invoice is partly paid; a plan would double-bill");
  if (plan.length < 2 || sum !== outstanding) throw new Error(`Plan sums to ${sum} but ${outstanding} is outstanding`);
  const ref = original.invoiceNumber ? `invoice ${original.invoiceNumber}` : "the original invoice";
  const base = { currency: original.currency, ...parties };

  if (strategy === "partial_payment") {
    return [
      {
        ...base,
        items: original.items,
        dueDate: plan[plan.length - 1].dueDate,
        partialPayment: { minimumAmountDueMinor: plan[0].amountMinor },
        note: `Replaces ${ref}. Agreed payment plan: ${scheduleText(plan, original.currency)}.`,
      },
    ];
  }
  const what = original.items.map((i) => i.name).join(", ").slice(0, 900);
  return plan.map((p, i) => ({
    ...base,
    items: [{ name: `Instalment ${i + 1} of ${plan.length}`, description: `Part payment for ${ref}: ${what}`, quantity: 1, unitAmountMinor: p.amountMinor, unit: "AMOUNT" as const }],
    dueDate: p.dueDate,
    note: `Instalment ${i + 1} of ${plan.length}, replacing ${ref}. Full plan: ${scheduleText(plan, original.currency)}.`,
  }));
}

export interface PlanPayPal {
  getInvoice(id: string): Promise<PayPalInvoice>;
  createDraftInvoice(input: CreateInvoiceInput): Promise<PayPalInvoice>;
  sendInvoice(id: string): Promise<{ payerViewUrl?: string }>;
  cancelInvoice(id: string, opts: { sendToRecipient: boolean; note?: string }): Promise<void>;
  deleteDraftInvoice(id: string): Promise<void>;
}

/** Persistence for one plan group (Prisma in the app, in-memory in tests). */
export interface PlanStore {
  drafted(drafts: { paypalInvoiceId: string; input: CreateInvoiceInput }[]): Promise<void>;
  sent(paypalInvoiceId: string, payerViewUrl: string | undefined): Promise<void>;
  state(state: "pending_send" | "active" | "aborted", error?: string): Promise<void>;
}

export class PlanAborted extends Error {}

const OPEN = ["SENT", "UNPAID", "SCHEDULED"];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function discard(ids: string[], api: PlanPayPal) {
  await Promise.all(ids.map((id) => api.deleteDraftInvoice(id).catch(() => undefined)));
}

/** Replaces the original invoice with the plan's drafts. The client always has something payable: the original
 * is only cancelled once every draft exists, and only if it is still unpaid at that moment. */
export async function executePlan(originalPaypalId: string, drafts: CreateInvoiceInput[], api: PlanPayPal, store: PlanStore) {
  const created: { paypalInvoiceId: string; input: CreateInvoiceInput }[] = [];
  const abort = async (why: string): Promise<never> => {
    await discard(created.map((c) => c.paypalInvoiceId), api);
    await store.state("aborted", why);
    throw new PlanAborted(why);
  };

  for (const input of drafts) {
    try {
      created.push({ paypalInvoiceId: (await api.createDraftInvoice(input)).id, input });
    } catch (e) {
      await abort(`Could not create the plan invoices: ${message(e)}`);
    }
  }
  await store.drafted(created);

  // Status check right before cancelling: the client may have paid in the meantime.
  let original: PayPalInvoice;
  try {
    original = await api.getInvoice(originalPaypalId);
  } catch (e) {
    return abort(`Could not re-check the original invoice: ${message(e)}`);
  }
  const paid = original.payments?.paid_amount && Number(original.payments.paid_amount.value) > 0;
  if (!OPEN.includes(original.status) || paid) await abort(`Original invoice is ${original.status}${paid ? " and partly paid" : ""}; plan not applied`);

  try {
    await api.cancelInvoice(originalPaypalId, { sendToRecipient: false, note: "Replaced by an agreed payment plan." });
  } catch (e) {
    await abort(`Could not cancel the original invoice: ${message(e)}`);
  }
  await store.state("pending_send");
  return sendPending(created.map((c) => c.paypalInvoiceId), api, store);
}

/** Sends drafts that haven't gone out yet. Leaves the group in pending_send (to be retried) if any send fails. */
export async function sendPending(paypalIds: string[], api: PlanPayPal, store: PlanStore) {
  const errors: string[] = [];
  for (const id of paypalIds) {
    try {
      const { payerViewUrl } = await api.sendInvoice(id);
      await store.sent(id, payerViewUrl);
    } catch (e) {
      errors.push(`${id}: ${message(e)}`);
    }
  }
  if (errors.length) {
    await store.state("pending_send", errors.join("; "));
    return { state: "pending_send" as const, errors };
  }
  await store.state("active");
  return { state: "active" as const, errors };
}
