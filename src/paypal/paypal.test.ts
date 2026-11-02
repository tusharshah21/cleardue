import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAccessToken, PayPalError, paypalRequest, resetTokenCache } from "./client";
import { buildInvoiceBody, createDraftInvoice, sendInvoice } from "./invoices";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const token = () => json({ access_token: "tok", expires_in: 32400 });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetTokenCache();
  vi.stubEnv("PAYPAL_CLIENT_ID", "id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
  vi.stubEnv("PAYPAL_BASE_URL", "https://api-m.sandbox.paypal.com");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("PayPal client", () => {
  it("caches the OAuth token across requests", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ a: 1 })).mockResolvedValueOnce(json({ a: 2 }));
    await paypalRequest("/x");
    await paypalRequest("/y");
    const tokenCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/v1/oauth2/token"));
    expect(tokenCalls).toHaveLength(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer tok");
  });

  it("refuses non-sandbox hosts", async () => {
    vi.stubEnv("PAYPAL_BASE_URL", "https://api-m.paypal.com");
    await expect(getAccessToken()).rejects.toThrow(/never talks to live PayPal/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains missing credentials", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "");
    await expect(getAccessToken()).rejects.toThrow(/PAYPAL_CLIENT_ID/);
  });

  it("turns PayPal error bodies into readable messages", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(
      json(
        {
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed.",
          debug_id: "abc123",
          details: [{ field: "/configuration/partial_payment", issue: "PARTIAL_PAYMENT_NOT_ALLOWED" }],
        },
        422,
      ),
    );
    const err = (await paypalRequest("/v2/invoicing/invoices", { method: "POST", body: {} }).catch((e) => e)) as PayPalError;
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.status).toBe(422);
    expect(err.debugId).toBe("abc123");
    expect(err.message).toContain("PARTIAL_PAYMENT_NOT_ALLOWED");
  });

  it("retries once with a fresh token on 401", async () => {
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({ ok: true }));
    await expect(paypalRequest("/x")).resolves.toEqual({ ok: true });
  });

  it("reports timeouts readably", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    await expect(getAccessToken()).rejects.toThrow(/did not respond/);
  });

  it("handles empty 204 bodies", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(paypalRequest("/x", { method: "POST" })).resolves.toBeUndefined();
  });
});

describe("invoices", () => {
  const input = {
    currency: "USD",
    invoicerBusinessName: "Priya Designs",
    recipientEmail: "ap@acme.test",
    recipientName: "Acme Labs",
    items: [
      { name: "Design sprint", quantity: 12, unitAmountMinor: 4500, unit: "HOURS" as const },
      { name: "Responsive QA", description: "Cross-device checks", quantity: 1, unitAmountMinor: 30000, unit: "AMOUNT" as const },
    ],
    dueDate: new Date("2026-11-20T00:00:00Z"),
    note: "Thanks!",
  };

  it("builds a v2 invoice body with string amounts and due date", () => {
    const body = buildInvoiceBody(input);
    expect(body.detail.payment_term).toEqual({ term_type: "DUE_ON_DATE_SPECIFIED", due_date: "2026-11-20" });
    expect(body.items[0]).toMatchObject({ quantity: "12", unit_amount: { value: "45.00" }, unit_of_measure: "HOURS" });
    expect(body.items[1]).toMatchObject({ unit_amount: { value: "300.00" }, unit_of_measure: "AMOUNT" });
    expect(body.configuration).toEqual({ allow_tip: false });
  });

  it("adds partial payment only when asked", () => {
    const body = buildInvoiceBody({ ...input, partialPayment: { minimumAmountDueMinor: 25000 } });
    expect(body.configuration.partial_payment).toEqual({
      allow_partial_payment: true,
      minimum_amount_due: { currency_code: "USD", value: "250.00" },
    });
  });

  it("creates a draft with return=representation", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ id: "INV2-1", status: "DRAFT", detail: { currency_code: "USD" } }, 201));
    const inv = await createDraftInvoice(input);
    expect(inv.id).toBe("INV2-1");
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://api-m.sandbox.paypal.com/v2/invoicing/invoices");
    expect(init.headers.Prefer).toBe("return=representation");
  });

  it("extracts the payer-view link after send", async () => {
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({ href: "https://www.sandbox.paypal.com/invoice/p/#INV2-1", rel: "payer-view", method: "GET" }));
    await expect(sendInvoice("INV2-1")).resolves.toEqual({ payerViewUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2-1" });
  });
});
