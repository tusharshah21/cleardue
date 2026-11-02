// Sandbox spike: answers M1's open questions against the real sandbox.
//   1. Can this business account create and send a USD invoice?
//   2. Does PayPal accept configuration.partial_payment for this account? (blocked for IN/BR/IL invoicers)
//   3. Does /remind accept additional_recipients? (then check the AP inbox under Sandbox > Notifications)
// Cleans up after itself (cancel with send_to_recipient=false, delete drafts).
// Usage: npm run paypal:spike   (needs PAYPAL_*, SPIKE_PAYER_EMAIL, SPIKE_AP_EMAIL in .env)
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { getAccessToken } from "../src/paypal/client";
import {
  cancelInvoice,
  createDraftInvoice,
  deleteDraftInvoice,
  getInvoice,
  remindInvoice,
  sendInvoice,
  type CreateInvoiceInput,
} from "../src/paypal/invoices";

const payer = process.env.SPIKE_PAYER_EMAIL;
const ap = process.env.SPIKE_AP_EMAIL;
if (!payer || !ap) throw new Error("Set SPIKE_PAYER_EMAIL (sandbox personal account) and SPIKE_AP_EMAIL in .env");

const results: Record<string, unknown> = { ranAt: new Date().toISOString() };
const step = async <T,>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
  try {
    const out = await fn();
    results[name] = { ok: true, out };
    console.log(`PASS ${name}`);
    return out;
  } catch (e) {
    results[name] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : e}`);
  }
};

const base: CreateInvoiceInput = {
  currency: "USD",
  invoicerBusinessName: "ClearDue Spike",
  recipientEmail: payer,
  recipientName: "Spike Client",
  items: [{ name: "Spike line", quantity: 1, unitAmountMinor: 1000, unit: "AMOUNT" }],
  dueDate: new Date(Date.now() + 7 * 86_400_000),
  note: "ClearDue sandbox spike, safe to ignore.",
};

await step("oauth_token", async () => ((await getAccessToken()) ? "received" : "empty"));
const inv = await step("create_usd_draft", async () => {
  const i = await createDraftInvoice(base);
  return { id: i.id, status: i.status };
});
const partial = await step("create_partial_payment_draft", async () => {
  const i = await createDraftInvoice({ ...base, partialPayment: { minimumAmountDueMinor: 500 } });
  return { id: i.id, status: i.status };
});
if (inv) {
  await step("send", () => sendInvoice(inv.id));
  await step("get_after_send", async () => {
    const i = await getInvoice(inv.id);
    return { status: i.status, recipient_view_url: i.detail.metadata?.recipient_view_url };
  });
  await step("remind_with_additional_recipients", async () => {
    await remindInvoice(inv.id, { subject: "Spike reminder", note: "Forwarded to AP", additionalRecipients: [ap] });
    return `accepted; now check Sandbox > Notifications for an email to ${ap}`;
  });
  await step("cancel_silently", () => cancelInvoice(inv.id, { sendToRecipient: false }));
}
if (partial) await step("delete_partial_draft", () => deleteDraftInvoice(partial.id));

mkdirSync("docs/progress", { recursive: true });
writeFileSync("docs/progress/paypal-spike.json", JSON.stringify(results, null, 2));
console.log("Wrote docs/progress/paypal-spike.json");
