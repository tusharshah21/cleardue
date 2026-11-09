// Manual "doctor" checks against the sandbox, for the two symptoms in docs/paypal-doctor.md. Read-only, apart from one
// test draft that is created, updated and deleted. Prints no credentials, tokens or webhook ids.
//   npx tsx scripts/paypal-checks.mts [hosted base url]
import "dotenv/config";
import { PayPalError, paypalRequest } from "../src/paypal/client";
import { createDraftInvoice, deleteDraftInvoice, getInvoice, updateDraftInvoice } from "../src/paypal/invoices";
import { INVOICE_EVENTS } from "../src/paypal/webhooks";

const show = (e: unknown) => (e instanceof PayPalError ? `${e.status} ${e.paypalName ?? ""} debug_id=${e.debugId ?? "-"} ${JSON.stringify(e.details ?? "")}` : String(e));
const hosted = (process.argv[2] ?? process.env.APP_URL ?? "").replace(/\/$/, "");

console.log("== Symptom: webhooks not being received");
const hooks = await paypalRequest<{ webhooks: { id: string; url: string; event_types: { name: string }[] }[] }>("/v1/notifications/webhooks");
const mine = hooks.webhooks.find((w) => w.id === process.env.PAYPAL_WEBHOOK_ID);
console.log(`webhooks on this app: ${hooks.webhooks.length}; PAYPAL_WEBHOOK_ID matches one: ${!!mine}`);
for (const w of hooks.webhooks) {
  const names = w.event_types.map((t) => t.name);
  console.log(`- ${w.url}  events: ${names.join(", ")}  missing: ${INVOICE_EVENTS.filter((n) => !names.includes(n) && !names.includes("*")).join(", ") || "none"}${w.id === process.env.PAYPAL_WEBHOOK_ID ? "  (this is PAYPAL_WEBHOOK_ID)" : ""}`);
}
try {
  const events = await paypalRequest<{ events: { event_type: string; create_time: string }[] }>("/v1/notifications/webhooks-events?page_size=20");
  console.log(`recent events PayPal generated for this app: ${events.events.length}`);
  for (const e of events.events.slice(0, 8)) console.log(`  ${e.create_time} ${e.event_type}`);
} catch (e) {
  console.log("listing webhook events failed:", show(e));
}
if (hosted) {
  const res = await fetch(`${hosted}/api/webhooks/paypal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  console.log(`POST ${hosted}/api/webhooks/paypal with an empty body -> ${res.status} (400 means the route is up and refuses non-events)`);
}

console.log("\n== Symptom: invoice update rejected");
const input = {
  currency: "USD",
  invoicerBusinessName: "ClearDue update test",
  recipientEmail: "nobody@example.com",
  recipientName: "Update test",
  items: [{ name: "First line", quantity: 1, unitAmountMinor: 1000, unit: "AMOUNT" as const }],
  dueDate: new Date(Date.now() + 7 * 86_400_000),
};
const draft = await createDraftInvoice(input);
try {
  const before = await getInvoice(draft.id);
  await updateDraftInvoice(draft.id, { ...input, items: [...input.items, { name: "Second line", quantity: 2, unitAmountMinor: 500, unit: "AMOUNT" }] });
  const after = await getInvoice(draft.id);
  console.log(`full update of a draft: ok; total ${before.amount?.value} -> ${after.amount?.value}; invoice number kept: ${before.detail.invoice_number === after.detail.invoice_number}`);
} catch (e) {
  console.log("full update of a draft rejected:", show(e));
} finally {
  await deleteDraftInvoice(draft.id).catch((e) => console.log("cleanup failed:", show(e)));
}
