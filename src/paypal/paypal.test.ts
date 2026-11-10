import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkPayPalAuth, getAccessToken, PayPalError, paypalRequest, plainPayPalMessage, resetAuthCheck, resetTokenCache } from "./client";
import { buildInvoiceBody, createDraftInvoice, sendInvoice, updateDraftInvoice } from "./invoices";
import { readFileSync } from "node:fs";
import { heldPaymentReason } from "./invoices";
import { invoiceIdOf, verifyWebhookSignature } from "./webhooks";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const token = () => json({ access_token: "tok", expires_in: 32400 });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetTokenCache();
  resetAuthCheck();
  vi.stubEnv("PAYPAL_MODE", "sandbox");
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

  it("keeps the token for its ~9 hour life, refreshes a minute before expiry, and retries a 401 only once", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-09T09:00:00Z") });
    try {
      const tokenCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/v1/oauth2/token")).length;
      fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/v1/oauth2/token") ? token() : json({ ok: true })));
      await paypalRequest("/x");
      vi.advanceTimersByTime(8 * 3600_000 + 58 * 60_000); // 8h58m: still the same token (expires_in 32400s = 9h)
      await paypalRequest("/x");
      expect(tokenCalls()).toBe(1);
      vi.advanceTimersByTime(60_000); // 8h59m: inside the last minute, so a fresh one is fetched
      await paypalRequest("/x");
      expect(tokenCalls()).toBe(2);

      // A second 401 in a row is an answer, not a glitch: no loop.
      fetchMock.mockReset().mockImplementation(async (url: string) => (String(url).endsWith("/v1/oauth2/token") ? token() : json({ name: "AUTHENTICATION_FAILURE", debug_id: "d401" }, 401)));
      const err = (await paypalRequest("/x").catch((e) => e)) as PayPalError;
      expect(err.status).toBe(401);
      expect(fetchMock.mock.calls.filter(([url]) => !String(url).endsWith("/v1/oauth2/token"))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs status, error name and debug_id, never the token or body, and gives the freelancer a plain sentence", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // Recorded from the sandbox: reminding a draft.
    const body = { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed, semantically incorrect, or failed business validation.", debug_id: "f34268289bfd1", details: [{ issue: "CANNOT_REMIND_INVOICE", description: "You cannot remind an invoice which is in DRAFT status. Only UNPAID, SENT and PARTIALLY_PAID invoices can be reminded." }] };
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(json(body, 422));
    const err = await paypalRequest("/v2/invoicing/invoices/INV2-1/remind", { method: "POST", body: { note: "secret client note", email: "client@example.com" } }).catch((e) => e);
    const line = log.mock.calls.flat().join(" ");
    expect(line).toBe("[paypal] POST /v2/invoicing/invoices/INV2-1/remind failed: status=422 name=UNPROCESSABLE_ENTITY issues=CANNOT_REMIND_INVOICE debug_id=f34268289bfd1");
    expect(line).not.toMatch(/tok|secret|client@example/);
    expect(plainPayPalMessage(err)).toBe("PayPal only sends reminders for invoices that have been sent and are still unpaid. Press Sync to see the invoice's current state. (PayPal reference f34268289bfd1)");
    expect(plainPayPalMessage(new PayPalError("PayPal 503: down", 503, "x1"))).toMatch(/^PayPal is having trouble right now \(503\)\. Nothing was changed/);
    log.mockRestore();
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

describe("webhooks", () => {
  const signed = new Headers({
    "paypal-transmission-id": "t1",
    "paypal-transmission-sig": "sig",
    "paypal-transmission-time": "2026-11-10T00:00:00Z",
    "paypal-cert-url": "https://api.sandbox.paypal.com/cert",
    "paypal-auth-algo": "SHA256withRSA",
  });
  const event = { id: "WH-1", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-9" } } };

  it("verifies through PayPal and sends the event back unchanged", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WHID");
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ verification_status: "SUCCESS" }));
    await expect(verifyWebhookSignature(signed, event)).resolves.toEqual({ verified: true });
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(fetchMock.mock.calls[1][0]).toContain("/v1/notifications/verify-webhook-signature");
    expect(body).toMatchObject({ webhook_id: "WHID", transmission_id: "t1", transmission_sig: "sig", webhook_event: event });
  });

  it("rejects FAILURE, missing headers, a missing webhook id, and API errors", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "WHID");
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ verification_status: "FAILURE" }));
    await expect(verifyWebhookSignature(signed, event)).resolves.toEqual({ verified: false, reason: "verification_status FAILURE" });
    await expect(verifyWebhookSignature(new Headers(), event)).resolves.toMatchObject({ verified: false, reason: "missing PayPal signature headers" });
    fetchMock.mockResolvedValueOnce(json({ message: "boom" }, 500));
    await expect(verifyWebhookSignature(signed, event)).resolves.toMatchObject({ verified: false });
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");
    await expect(verifyWebhookSignature(signed, event)).resolves.toMatchObject({ verified: false, reason: "PAYPAL_WEBHOOK_ID is not set" });
  });

  it("finds the invoice id in v2 and flat resources", () => {
    expect(invoiceIdOf(event)).toBe("INV2-9");
    expect(invoiceIdOf({ id: "x", event_type: "y", resource: { id: "INV2-8" } })).toBe("INV2-8");
    expect(invoiceIdOf({ id: "x", event_type: "y" })).toBeNull();
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

  it("replaces a draft with a full PUT that doesn't notify anyone", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ id: "INV2-1", status: "DRAFT", detail: { currency_code: "USD" } }));
    await updateDraftInvoice("INV2-1", input);
    const [url, init] = fetchMock.mock.calls[1];
    expect(init.method).toBe("PUT");
    expect(url).toBe("https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-1?send_to_recipient=false&send_to_invoicer=false");
    expect(JSON.parse(init.body)).toMatchObject({ id: "INV2-1", items: [{ name: "Design sprint" }, { name: "Responsive QA" }] });
  });

  it("extracts the payer-view link after send", async () => {
    fetchMock
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({ href: "https://www.sandbox.paypal.com/invoice/p/#INV2-1", rel: "payer-view", method: "GET" }));
    await expect(sendInvoice("INV2-1")).resolves.toEqual({ payerViewUrl: "https://www.sandbox.paypal.com/invoice/p/#INV2-1" });
  });
});

describe("credential watch", () => {
  const rejected = () => json({ error: "invalid_client", error_description: "Client Authentication failed" }, 401);

  it("is ok when PayPal issues a token, and remembers that for 5 minutes", async () => {
    fetchMock.mockResolvedValueOnce(token());
    expect(await checkPayPalAuth(1_000)).toEqual({ ok: true });
    expect(await checkPayPalAuth(1_000 + 4 * 60_000)).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(token());
    await checkPayPalAuth(1_000 + 6 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks PayPal afresh even when a token is cached, so a revoked secret shows up", async () => {
    fetchMock.mockResolvedValueOnce(token());
    await getAccessToken();
    fetchMock.mockResolvedValueOnce(rejected());
    const s = await checkPayPalAuth();
    expect(s.ok).toBe(false);
    expect(s.problem).toBe("rejected");
    expect(s.error).toContain("Client Authentication failed");
  });

  it("tells a rejection from an outage and from missing config", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    expect((await checkPayPalAuth()).problem).toBe("unreachable");
    resetAuthCheck();
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "");
    expect((await checkPayPalAuth()).problem).toBe("unconfigured");
  });

  it("is always ok in mock mode and never calls PayPal", async () => {
    vi.stubEnv("PAYPAL_MODE", "mock");
    expect(await checkPayPalAuth()).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("held payments", () => {
  const pending = JSON.parse(readFileSync("src/paypal/fixtures/invoice-payment-pending.json", "utf8"));
  const capture = JSON.parse(readFileSync("src/paypal/fixtures/capture-pending.json", "utf8"));

  it("finds the invoice a capture event names (invoice_id), and leaves invoice events as they were", () => {
    expect(invoiceIdOf({ id: "1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP1", invoice_id: "INV2-X" } })).toBe("INV2-X");
    expect(invoiceIdOf({ id: "2", event_type: "INVOICING.INVOICE.PAID", resource: { id: "INV2-Y" } })).toBe("INV2-Y");
    expect(invoiceIdOf({ id: "3", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-Z" } } })).toBe("INV2-Z");
  });

  it("reads PayPal's reason for the hold from the payment, with the recorded responses", async () => {
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(json(capture));
    expect(await heldPaymentReason(pending)).toBe("RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api-m.sandbox.paypal.com/v2/payments/captures/12Y361605S103763T");
  });

  it("is null, never an error, when the lookup fails or there is no payment id", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(json({ name: "NOT_AUTHORIZED", debug_id: "abc" }, 403));
    expect(await heldPaymentReason(pending)).toBeNull();
    expect(await heldPaymentReason({ ...pending, payments: {} })).toBeNull();
    vi.mocked(console.error).mockRestore();
  });
});
