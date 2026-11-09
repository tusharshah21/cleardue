// "Payments received (live from PayPal)": money that actually arrived in the PayPal account, read from the Transaction
// Search API (GET /v1/reporting/transactions), next to ClearDue's own records. Read-only.
// PayPal allows at most 31 days per request, so 90 days is three 30-day windows. Transaction Search lags real time
// (PayPal says up to three hours), which is why the response's last_refreshed_datetime is shown with the data.
// One PayPal app serves this deployment, so the payments are that merchant account's, the same as the invoices.
import { toMinor } from "@/lib/money";
import { PayPalError, paypalRequest, plainPayPalMessage } from "./client";

export interface PaymentRow {
  id: string;
  /** ISO timestamp (UTC) the payment started. */
  date: string;
  /** Major units, for charts: 1800.5. Money maths uses amountMinor. */
  amount: number;
  amountMinor: number;
  currency: string;
  status: "Completed" | "Pending" | "Reversed" | "Denied" | "Unknown";
  /** The invoice number PayPal recorded, when the payment was for an invoice. */
  invoiceNumber: string | null;
  payer: string | null;
}

export type PaymentsResult =
  | { ok: true; rows: PaymentRow[]; fetchedAt: string; refreshedAt: string | null; days: number }
  | { ok: false; rows: []; fetchedAt: string; message: string; days: number };

interface Money {
  currency_code?: string;
  value?: string;
}
interface Detail {
  transaction_info?: {
    transaction_id?: string;
    transaction_initiation_date?: string;
    transaction_amount?: Money;
    transaction_status?: string;
    invoice_id?: string;
  };
  payer_info?: { payer_name?: { given_name?: string; surname?: string; alternate_full_name?: string } };
}
export interface SearchResponse {
  transaction_details?: Detail[];
  last_refreshed_datetime?: string;
  total_pages?: number;
}

export const DAYS = 90;
const WINDOW_DAYS = 30;
const CACHE_MS = 5 * 60_000;
const ERROR_CACHE_MS = 60_000;
const STATUS: Record<string, PaymentRow["status"]> = { S: "Completed", P: "Pending", V: "Reversed", D: "Denied" };

const iso = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
/** PayPal writes "2026-11-02T10:15:03+0000"; Date wants "+00:00". */
const utc = (s = "") => {
  const d = new Date(s.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
};

/** Money in, from one Transaction Search response. Outgoing transfers, fees and refunds (negative amounts) are left out. */
export function toPaymentRows(res: SearchResponse): PaymentRow[] {
  return (res.transaction_details ?? []).flatMap(({ transaction_info: t, payer_info: p }) => {
    const value = t?.transaction_amount?.value ?? "";
    const currency = t?.transaction_amount?.currency_code ?? "";
    let amountMinor: number;
    try {
      amountMinor = toMinor(value, currency); // throws on negatives and malformed values: both are left out
    } catch {
      return [];
    }
    if (!t?.transaction_id || amountMinor <= 0) return [];
    const n = p?.payer_name;
    const payer = n?.alternate_full_name || [n?.given_name, n?.surname].filter(Boolean).join(" ") || null;
    return [{ id: t.transaction_id, date: utc(t.transaction_initiation_date), amount: Number(value), amountMinor, currency, status: STATUS[t.transaction_status ?? ""] ?? "Unknown", invoiceNumber: t.invoice_id || null, payer }];
  });
}

/** What the freelancer reads when the call fails. A 403 here means the app lacks the Transaction Search permission,
 * not bad credentials (invoicing still works), so it gets its own sentence. */
export function paymentsErrorText(e: unknown): string {
  if (e instanceof PayPalError && e.status === 403) {
    return `PayPal hasn't given this app access to Transaction Search, so payments can't be read from PayPal yet. Turn on Transaction Search for the app in the PayPal developer dashboard; it can take a few hours to apply.${e.debugId ? ` (PayPal reference ${e.debugId})` : ""}`;
  }
  return `Couldn't read payments from PayPal just now. ${plainPayPalMessage(e)}`;
}

let cache: { at: number; result: PaymentsResult } | null = null;

export function resetPaymentsCache() {
  cache = null;
}

/** The last 90 days of payments received, newest first, cached for 5 minutes (a failure for 1 minute). Never throws. */
export async function paymentsReceived(now = new Date()): Promise<PaymentsResult> {
  if (cache && now.getTime() - cache.at < (cache.result.ok ? CACHE_MS : ERROR_CACHE_MS)) return cache.result;
  let result: PaymentsResult;
  try {
    const windows = [0, 1, 2].map((i) => {
      const end = new Date(now.getTime() - i * WINDOW_DAYS * 864e5);
      return { start: new Date(end.getTime() - WINDOW_DAYS * 864e5), end };
    });
    // ponytail: first page of 500 per window; follow total_pages if a month ever has more than 500 payments.
    const pages = await Promise.all(windows.map((w) => paypalRequest<SearchResponse>(`/v1/reporting/transactions?start_date=${iso(w.start)}&end_date=${iso(w.end)}&fields=transaction_info,payer_info&page_size=500`)));
    const seen = new Set<string>();
    const rows = pages
      .flatMap(toPaymentRows)
      .filter((r) => !seen.has(r.id) && !!seen.add(r.id))
      .sort((a, b) => b.date.localeCompare(a.date));
    const refreshed = pages.map((p) => p.last_refreshed_datetime).filter((d): d is string => !!d).map(utc).sort()[0] ?? null;
    result = { ok: true, rows, fetchedAt: now.toISOString(), refreshedAt: refreshed, days: DAYS };
  } catch (e) {
    if (!(e instanceof PayPalError)) console.error("[paypal] transaction search failed:", e instanceof Error ? e.name : "error");
    result = { ok: false, rows: [], fetchedAt: now.toISOString(), message: paymentsErrorText(e), days: DAYS };
  }
  cache = { at: now.getTime(), result };
  return result;
}
