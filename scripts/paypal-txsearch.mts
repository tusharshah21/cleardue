// Is Transaction Search enabled, and what comes back? Run by hand:  npx tsx scripts/paypal-txsearch.mts
// Prints counts, statuses and field names only: no tokens, no names, no emails, no amounts per payer.
import "dotenv/config";
import { PayPalError, paypalRequest } from "../src/paypal/client";

const iso = (d: Date) => d.toISOString().slice(0, 19) + "Z";
const end = new Date();
for (let i = 0; i < 3; i++) {
  const to = new Date(end.getTime() - i * 30 * 864e5);
  const from = new Date(to.getTime() - 30 * 864e5);
  try {
    const r = await paypalRequest<{ total_items?: number; total_pages?: number; transaction_details?: { transaction_info?: Record<string, unknown>; payer_info?: Record<string, unknown> }[] }>(
      `/v1/reporting/transactions?start_date=${iso(from)}&end_date=${iso(to)}&fields=transaction_info,payer_info&page_size=100`,
    );
    const rows = r.transaction_details ?? [];
    console.log(`window ${i}: total_items=${r.total_items} pages=${r.total_pages} rows=${rows.length}`);
    const ti = rows[0]?.transaction_info;
    if (ti) console.log("  transaction_info keys:", Object.keys(ti).join(","), "| payer_info keys:", Object.keys(rows[0]?.payer_info ?? {}).join(","));
    const codes: Record<string, number> = {};
    for (const t of rows) {
      const k = `${t.transaction_info?.transaction_event_code}/${t.transaction_info?.transaction_status}/${String((t.transaction_info?.transaction_amount as { value?: string })?.value ?? "").startsWith("-") ? "out" : "in"}`;
      codes[k] = (codes[k] ?? 0) + 1;
    }
    console.log("  event/status/direction:", JSON.stringify(codes));
  } catch (e) {
    console.log(`window ${i}:`, e instanceof PayPalError ? { status: e.status, name: e.paypalName, debug_id: e.debugId } : String(e));
  }
}
