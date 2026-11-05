import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  invoice: { findUnique: vi.fn() },
  planGroup: { findUnique: vi.fn() },
}));
const paypal = vi.hoisted(() => ({ getInvoice: vi.fn(), recordPayment: vi.fn() }));
const sync = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/invoicing", () => ({ syncInvoice: sync }));
vi.mock("@/paypal/invoices", () => paypal);

import { markPaidSandbox, sandboxTestPayEnabled } from "./sandbox-pay";

const open = { id: "i1", paypalInvoiceId: "INV2-1", status: "SENT", totalMinor: 320000, paidMinor: 0 };

beforeEach(() => {
  vi.stubEnv("PAYPAL_MODE", "sandbox");
  vi.stubEnv("PAYPAL_CLIENT_ID", "id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
  vi.stubEnv("PAYPAL_BASE_URL", "https://api-m.sandbox.paypal.com");
  db.invoice.findUnique.mockReset().mockImplementation(async ({ where }: { where: { payToken?: string; id?: string } }) => (where.payToken === "tok" || where.id === "i1" ? open : where.id === "part" ? { ...open, id: "part", paypalInvoiceId: "INV2-P" } : null));
  db.planGroup.findUnique.mockReset().mockResolvedValue(null);
  paypal.getInvoice.mockReset().mockResolvedValue({ status: "SENT", due_amount: { currency_code: "AUD", value: "3200.00" } });
  paypal.recordPayment.mockReset().mockResolvedValue({ payment_id: "PAY-1" });
  sync.mockReset().mockResolvedValue(open);
});
afterEach(() => vi.unstubAllEnvs());

describe("Mark as paid (sandbox test)", () => {
  it("is available on the PayPal sandbox only, never in mock mode or against another host", () => {
    expect(sandboxTestPayEnabled()).toBe(true);
    vi.stubEnv("PAYPAL_MODE", "mock");
    expect(sandboxTestPayEnabled()).toBe(false);
    vi.stubEnv("PAYPAL_MODE", "sandbox");
    vi.stubEnv("PAYPAL_BASE_URL", "https://api-m.paypal.com");
    expect(sandboxTestPayEnabled()).toBe(false);
  });

  it("records the full amount due through the Invoicing API, then syncs the invoice", async () => {
    await markPaidSandbox("tok", "i1");
    expect(paypal.recordPayment).toHaveBeenCalledWith("INV2-1", expect.objectContaining({ amount: { currency_code: "AUD", value: "3200.00" }, method: "OTHER" }));
    expect(sync).toHaveBeenCalledWith(open, "sandbox test payment");
  });

  it("refuses outside the sandbox without touching PayPal", async () => {
    vi.stubEnv("PAYPAL_MODE", "mock");
    await expect(markPaidSandbox("tok", "i1")).rejects.toThrow(/sandbox/i);
    expect(paypal.recordPayment).not.toHaveBeenCalled();
  });

  it("needs the pay token, and only reaches the invoice itself or a part of its plan", async () => {
    await expect(markPaidSandbox("wrong", "i1")).rejects.toThrow(/not found/i);
    await expect(markPaidSandbox("tok", "part")).rejects.toThrow(/not found/i);
    db.planGroup.findUnique.mockResolvedValue({ invoices: [{ id: "part" }] });
    await markPaidSandbox("tok", "part");
    expect(paypal.recordPayment).toHaveBeenCalledWith("INV2-P", expect.anything());
    expect(paypal.recordPayment).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a closed invoice or one with nothing due", async () => {
    db.invoice.findUnique.mockImplementation(async () => ({ ...open, status: "PAID" }));
    await expect(markPaidSandbox("tok", "i1")).rejects.toThrow(/nothing left/i);
    db.invoice.findUnique.mockImplementation(async () => open);
    paypal.getInvoice.mockResolvedValue({ status: "PAID", due_amount: { currency_code: "AUD", value: "0.00" } });
    await expect(markPaidSandbox("tok", "i1")).rejects.toThrow(/Nothing due/);
    expect(paypal.recordPayment).not.toHaveBeenCalled();
  });
});
