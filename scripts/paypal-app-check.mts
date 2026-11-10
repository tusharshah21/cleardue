// What does this sandbox app look like to PayPal? Run by hand:  npx tsx scripts/paypal-app-check.mts
// Prints yes/no answers, counts, webhook ids/urls/event names and one country code. Never prints the token, the client
// id or secret, or any name or email address. Creates one draft invoice to test partial payments, then deletes it.
import "dotenv/config";
import { PayPalError, paypalRequest } from "../src/paypal/client";
import { createDraftInvoice, deleteDraftInvoice, getInvoice } from "../src/paypal/invoices";

const show = (e: unknown) => (e instanceof PayPalError ? `${e.status} ${e.paypalName ?? ""} debug_id=${e.debugId ?? "-"} ${JSON.stringify(e.details ?? "")}` : String(e));

console.log("== Token");
const res = await fetch("https://api-m.sandbox.paypal.com/v1/oauth2/token", {
  method: "POST",
  headers: { Authorization: `Basic ${Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
});
const tok = (await res.json()) as { scope?: string; app_id?: string; expires_in?: number };
const scopes = (tok.scope ?? "").split(" ").filter(Boolean);
console.log(`status ${res.status}; scopes ${scopes.length}; expires_in ${tok.expires_in}`);
console.log("reporting/search/read scope present:", scopes.some((s) => s.endsWith("/reporting/search/read")) ? "YES" : "NO");
console.log("invoicing scope present:", scopes.some((s) => s.endsWith("/invoicing")) ? "yes" : "no");

console.log("== Webhooks on this app");
const hooks = await paypalRequest<{ webhooks: { id: string; url: string; event_types: { name: string }[] }[] }>("/v1/notifications/webhooks");
console.log("count:", hooks.webhooks.length, "| PAYPAL_WEBHOOK_ID in .env matches one:", hooks.webhooks.some((w) => w.id === process.env.PAYPAL_WEBHOOK_ID));
for (const w of hooks.webhooks) console.log(`- ${w.id} ${w.url} [${w.event_types.map((t) => t.name).join(", ")}]`);

console.log("== Business account country");
try {
  const info = await paypalRequest<{ address?: { country?: string }; account_type?: string }>("/v1/identity/oauth2/userinfo?schema=paypalv1.1");
  console.log("userinfo: country =", info.address?.country ?? "(not returned)", "| account_type =", info.account_type ?? "(not returned)");
} catch (e) {
  console.log("userinfo not available to this app:", show(e));
}

console.log("== Draft invoice: partial payments and the invoicer's country");
const input = {
  currency: "USD",
  invoicerBusinessName: "ClearDue app check",
  recipientEmail: "buyer@example.com",
  recipientName: "Example Buyer",
  items: [{ name: "App check (draft, deleted)", quantity: 1, unitAmountMinor: 1000, unit: "AMOUNT" as const }],
  dueDate: new Date(Date.now() + 7 * 864e5),
};
for (const partial of [false, true]) {
  let id: string | undefined;
  try {
    const d = await createDraftInvoice({ ...input, ...(partial && { partialPayment: { minimumAmountDueMinor: 500 } }) });
    id = d.id;
    const got = await getInvoice(d.id);
    console.log(`partial_payment=${partial}: accepted; flag kept: ${got.configuration?.partial_payment?.allow_partial_payment ?? false}; invoicer country: ${got.invoicer?.address?.country_code ?? "(not returned)"}`);
  } catch (e) {
    console.log(`partial_payment=${partial}: REFUSED ${show(e)}`);
  } finally {
    if (id) await deleteDraftInvoice(id).catch((e) => console.log("cleanup failed:", show(e)));
  }
}
