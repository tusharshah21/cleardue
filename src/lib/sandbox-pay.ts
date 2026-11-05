// "Mark as paid (sandbox test)": lets a judge without a PayPal sandbox buyer account see the payment flow. It records a
// payment on the PayPal sandbox invoice through the Invoicing API; PayPal then sends its normal signed webhook, which
// the verified-webhook route processes. Never available in mock mode or against anything but the sandbox host.
import { db } from "@/lib/db";
import { isOpen } from "@/lib/receivables";
import { syncInvoice } from "@/lib/invoicing";
import { config, paypalMode } from "@/paypal/client";
import { getInvoice, recordPayment } from "@/paypal/invoices";

/** The button shows (and the action runs) only against the real PayPal sandbox. */
export function sandboxTestPayEnabled(): boolean {
  try {
    return paypalMode() === "sandbox" && new URL(config().base).hostname === "api-m.sandbox.paypal.com";
  } catch {
    return false;
  }
}

/** `payToken` is the credential; `targetId` is the invoice itself or one part of its payment plan. */
export async function markPaidSandbox(payToken: string, targetId: string) {
  if (!sandboxTestPayEnabled()) throw new Error("Only available on the PayPal sandbox.");
  const main = await db.invoice.findUnique({ where: { payToken } });
  if (!main) throw new Error("Invoice not found.");
  const plan = await db.planGroup.findUnique({ where: { originalInvoiceId: main.id }, include: { invoices: { select: { id: true } } } });
  if (targetId !== main.id && !plan?.invoices.some((p) => p.id === targetId)) throw new Error("Invoice not found.");
  const target = await db.invoice.findUnique({ where: { id: targetId } });
  if (!target?.paypalInvoiceId || !isOpen(target)) throw new Error("This invoice has nothing left to pay.");
  const fresh = await getInvoice(target.paypalInvoiceId);
  if (!fresh.due_amount || Number(fresh.due_amount.value) <= 0) throw new Error(`Nothing due: invoice is ${fresh.status}.`);
  await recordPayment(target.paypalInvoiceId, {
    amount: fresh.due_amount,
    method: "OTHER",
    payment_date: new Date().toISOString().slice(0, 10),
    note: "Sandbox test payment (Mark as paid on the pay page)",
  });
  // Show the result now; PayPal's own webhook follows and is processed (and logged) by the webhook route.
  await syncInvoice(target, "sandbox test payment");
}
