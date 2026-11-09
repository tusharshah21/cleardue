// Sandbox fact-finding for the unhappy paths, run by hand:  npx tsx scripts/paypal-record.mts
//  1. records PayPal's own sample payloads for the four invoicing webhooks (simulate-event returns the event it sends;
//     it is delivered to example.com, not to our app) into src/paypal/fixtures/ for the tests;
//  2. triggers one real sandbox error and one PayPal-Mock-Response negative test, printing status, name and debug_id;
//  3. checks whether Transaction Search is enabled for this app.
// Prints no tokens and no request bodies.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { getAccessToken, PayPalError, paypalRequest } from "../src/paypal/client";
import { createDraftInvoice, deleteDraftInvoice, remindInvoice } from "../src/paypal/invoices";
import { INVOICE_EVENTS } from "../src/paypal/webhooks";

const show = (label: string, e: unknown) =>
  console.log(label, e instanceof PayPalError ? { status: e.status, name: e.paypalName, debug_id: e.debugId, details: e.details } : String(e));

const dir = "src/paypal/fixtures";
mkdirSync(dir, { recursive: true });
for (const type of INVOICE_EVENTS) {
  try {
    const ev = await paypalRequest<Record<string, unknown>>("/v1/notifications/simulate-event", {
      method: "POST",
      body: { url: "https://example.com/cleardue-fixture", event_type: type, resource_version: "2.0" },
    });
    writeFileSync(`${dir}/${type.toLowerCase().replaceAll(".", "-")}.json`, JSON.stringify(ev, null, 2) + "\n");
    console.log("recorded", type);
  } catch (e) {
    show(`simulate ${type}`, e);
  }
}

// A real error: reminding a draft (PayPal only reminds sent invoices). The draft is deleted afterwards.
const draft = await createDraftInvoice({
  currency: "USD",
  invoicerBusinessName: "ClearDue error test",
  recipientEmail: "nobody@example.com",
  recipientName: "Error test",
  items: [{ name: "Test", quantity: 1, unitAmountMinor: 100, unit: "AMOUNT" }],
  dueDate: new Date(Date.now() + 7 * 86_400_000),
});
try {
  await remindInvoice(draft.id);
  console.log("remind on a draft unexpectedly succeeded");
} catch (e) {
  show("real error, remind a draft:", e);
} finally {
  await deleteDraftInvoice(draft.id).catch((e) => show("cleanup", e));
}

// Negative testing: PayPal-Mock-Response on an Invoicing call.
try {
  await paypalRequest("/v2/invoicing/invoices?page=1&page_size=1", { headers: { "PayPal-Mock-Response": JSON.stringify({ mock_application_codes: "INTERNAL_SERVER_ERROR" }) } });
  console.log("mock-response header had no effect on GET /v2/invoicing/invoices");
} catch (e) {
  show("negative test GET invoices:", e);
}

// Transaction Search: 403 NOT_AUTHORIZED until it is enabled for the app.
const end = new Date();
const start = new Date(end.getTime() - 30 * 86_400_000);
try {
  const r = await paypalRequest<{ total_items?: number }>(`/v1/reporting/transactions?start_date=${start.toISOString().slice(0, 19)}Z&end_date=${end.toISOString().slice(0, 19)}Z&fields=transaction_info&page_size=1`);
  console.log("transaction search: enabled, total_items =", r.total_items);
} catch (e) {
  show("transaction search:", e);
}
await getAccessToken();
console.log("done");
