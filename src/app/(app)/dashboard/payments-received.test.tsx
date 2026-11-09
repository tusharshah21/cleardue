import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import sample from "@/paypal/fixtures/transaction-search.json";
import { toPaymentRows, type PaymentsResult } from "@/paypal/transactions";
import { PaymentsReceived } from "./payments-received";

const text = (result: PaymentsResult, ours: string[] = []) =>
  renderToStaticMarkup(<PaymentsReceived result={result} ourNumbers={new Set(ours)} />)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
const base = { fetchedAt: "2026-11-09T11:00:00.000Z", days: 90 };

describe("Payments received card", () => {
  it("labels PayPal as the source and matches payments against ClearDue's invoice numbers", () => {
    const t = text({ ...base, ok: true, rows: toPaymentRows(sample), refreshedAt: "2026-11-09T08:59:59.000Z" }, ["0233"]);
    expect(t).toContain("Payments received (live from PayPal)");
    expect(t).toContain("read from PayPal Transaction Search, not from ClearDue's records");
    expect(t).toContain("PayPal last updated this at 2026-11-09 08:59 UTC");
    expect(t).toContain("2 payments in PayPal, $2,400.00 completed. 1 matches a ClearDue invoice number.");
    expect(t).toContain("invoice 0233 in ClearDue");
    expect(t).toContain("no invoice number");
    expect(t).toContain("Pending");
  });

  it("says so when PayPal shows no payments", () => {
    expect(text({ ...base, ok: true, rows: [], refreshedAt: null })).toContain("PayPal shows no payments received in the last 90 days.");
  });

  it("shows the plain-English notice when the call failed", () => {
    const t = text({ ...base, ok: false, rows: [], message: "Couldn't read payments from PayPal just now." });
    expect(t).toContain("Couldn't read payments from PayPal just now. Everything else on this page comes from ClearDue's own records and is unaffected.");
  });
});
