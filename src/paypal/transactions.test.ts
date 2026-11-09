import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTokenCache } from "./client";
import sample from "./fixtures/transaction-search.json";
import { paymentsReceived, resetPaymentsCache, toPaymentRows } from "./transactions";

// The sample has PayPal's documented response shape with fictional data: an invoice payment, a pending payment with no
// invoice, and an outgoing transfer (negative) that must be left out.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const NOW = new Date("2026-11-09T11:00:00Z");
let fetchMock: ReturnType<typeof vi.fn>;
/** Answers the token call, then each Transaction Search window with `search(n)` (n = 0, 1, 2 in call order). */
const route = (search: (n: number) => Response) => {
  let n = 0;
  fetchMock.mockImplementation(async (url: string) => (url.endsWith("/v1/oauth2/token") ? json({ access_token: "tok", expires_in: 32400 }) : search(n++)));
};
const searches = () => fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/v1/reporting/transactions"));

beforeEach(() => {
  resetTokenCache();
  resetPaymentsCache();
  vi.stubEnv("PAYPAL_MODE", "sandbox");
  vi.stubEnv("PAYPAL_CLIENT_ID", "id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
  vi.stubEnv("PAYPAL_BASE_URL", "https://api-m.sandbox.paypal.com");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Payments received (Transaction Search)", () => {
  it("keeps money in only, with status, invoice number and payer", () => {
    expect(toPaymentRows(sample)).toEqual([
      { id: "5TY05013RG002845M", date: "2026-11-02T10:15:03.000Z", amount: 2400, amountMinor: 240000, currency: "USD", status: "Completed", invoiceNumber: "0233", payer: "Example Payer" },
      { id: "1FN09943UY4423436", date: "2026-10-20T08:00:00.000Z", amount: 900, amountMinor: 90000, currency: "GBP", status: "Pending", invoiceNumber: null, payer: "Second Example" },
    ]);
  });

  it("asks for 90 days as three windows of 30, merges them newest first and caches for 5 minutes", async () => {
    route((n) => json(n === 0 ? sample : { transaction_details: [], last_refreshed_datetime: "2026-11-09T09:30:00+0000" }));
    const r = await paymentsReceived(NOW);
    expect(r).toMatchObject({ ok: true, days: 90, refreshedAt: "2026-11-09T08:59:59.000Z" });
    expect(r.rows.map((x) => x.id)).toEqual(["5TY05013RG002845M", "1FN09943UY4423436"]);
    const urls = searches();
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain("start_date=2026-10-10T11:00:00Z&end_date=2026-11-09T11:00:00Z");
    expect(urls[2]).toContain("start_date=2026-08-11T11:00:00Z&end_date=2026-09-10T11:00:00Z");
    await paymentsReceived(new Date(NOW.getTime() + 4 * 60_000));
    expect(searches()).toHaveLength(3);
    await paymentsReceived(new Date(NOW.getTime() + 6 * 60_000));
    expect(searches()).toHaveLength(6);
  });

  it("is ok with no payments", async () => {
    route(() => json({ last_refreshed_datetime: "2026-11-09T08:59:59+0000", total_items: 0 }));
    expect(await paymentsReceived(NOW)).toMatchObject({ ok: true, rows: [] });
  });

  it("explains a missing Transaction Search permission in plain English, with PayPal's reference, and never throws", async () => {
    route(() => json({ name: "NOT_AUTHORIZED", message: "Authorization failed due to insufficient permissions.", debug_id: "f464841baa268", details: [{ issue: "NOT_AUTHORIZED" }] }, 403));
    const r = await paymentsReceived(NOW);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.rows).toEqual([]);
    expect(r.message).toMatch(/^PayPal hasn't given this app access to Transaction Search/);
    expect(r.message).toContain("(PayPal reference f464841baa268)");
    expect(r.message).not.toMatch(/credentials/);
  });

  it("says PayPal is having trouble on a 5xx, and retries after a minute rather than five", async () => {
    route(() => json({ name: "INTERNAL_SERVER_ERROR", debug_id: "abc123" }, 503));
    const r = await paymentsReceived(NOW);
    expect(r.ok ? "" : r.message).toMatch(/^Couldn't read payments from PayPal just now\. PayPal is having trouble right now \(503\)/);
    const before = searches().length;
    await paymentsReceived(new Date(NOW.getTime() + 30_000));
    expect(searches()).toHaveLength(before);
    await paymentsReceived(new Date(NOW.getTime() + 61_000));
    expect(searches().length).toBeGreaterThan(before);
  });
});
