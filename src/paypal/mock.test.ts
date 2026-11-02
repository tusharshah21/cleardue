import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolkitTools } from "@/agent/toolkit";
import { executePlan, replacementDrafts } from "@/plans/plans";
import { paypalMode, PayPalError } from "./client";
import * as paypal from "./invoices";
import { mockInvoice, resetMock } from "./mock";

const input = {
  currency: "GBP",
  invoicerBusinessName: "Aarav Mehta Design",
  recipientEmail: "sam@brightside.test",
  recipientName: "Brightside Studio",
  items: [
    { name: "Webflow build", quantity: 1, unitAmountMinor: 150000, unit: "AMOUNT" as const },
    { name: "CMS setup", quantity: 1, unitAmountMinor: 30000, unit: "AMOUNT" as const },
  ],
  dueDate: new Date("2026-10-28"),
};
const fetchSpy = vi.fn();

beforeEach(() => {
  vi.stubEnv("PAYPAL_MODE", "mock");
  vi.stubEnv("PAYPAL_MOCK_FILE", join(mkdtempSync(join(tmpdir(), "cleardue-mock-")), "store.json"));
  vi.stubEnv("PAYPAL_MOCK_COUNTRY", "IN");
  vi.stubGlobal("fetch", fetchSpy);
  resetMock();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function sent() {
  const draft = await paypal.createDraftInvoice(input);
  await paypal.sendInvoice(draft.id);
  return draft.id;
}

describe("PayPal mock", () => {
  it("runs an invoice through draft, update, send, remind, partial and full payment, with no network", async () => {
    const draft = await paypal.createDraftInvoice(input);
    expect(draft).toMatchObject({ status: "DRAFT", amount: { currency_code: "GBP", value: "1800.00" } });
    await paypal.updateDraftInvoice(draft.id, { ...input, items: [...input.items, { name: "Extra", quantity: 2, unitAmountMinor: 5000, unit: "HOURS" }] });
    expect((await paypal.getInvoice(draft.id)).amount?.value).toBe("1900.00");

    const { payerViewUrl } = await paypal.sendInvoice(draft.id);
    expect(payerViewUrl).toContain(`/dev/paypal/${draft.id}`);
    await paypal.remindInvoice(draft.id, { additionalRecipients: ["ap@brightside.test"] });
    expect(mockInvoice(draft.id)?.reminders[0].additional_recipients).toEqual(["ap@brightside.test"]);

    await paypal.recordPayment(draft.id, { amount: { currency_code: "GBP", value: "900.00" }, method: "PAYPAL", payment_date: "2026-11-02" });
    expect(await paypal.getInvoice(draft.id)).toMatchObject({ status: "PARTIALLY_PAID", due_amount: { value: "1000.00" }, payments: { paid_amount: { value: "900.00" } } });
    await paypal.recordPayment(draft.id, { amount: { currency_code: "GBP", value: "1000.00" }, method: "PAYPAL", payment_date: "2026-11-02" });
    expect((await paypal.getInvoice(draft.id)).status).toBe("PAID");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects what PayPal rejects, with readable errors", async () => {
    const id = await sent();
    await expect(paypal.deleteDraftInvoice(id)).rejects.toThrow(/Cannot delete an invoice in status SENT/);
    await expect(paypal.recordPayment(id, { amount: { currency_code: "GBP", value: "5000.00" }, method: "PAYPAL", payment_date: "2026-11-02" })).rejects.toThrow(/no more than the amount due/);
    await paypal.cancelInvoice(id, { sendToRecipient: false });
    await expect(paypal.cancelInvoice(id, { sendToRecipient: false })).rejects.toThrow(/status CANCELLED/);
    const err = (await paypal.getInvoice("INV2-NOPE").catch((e) => e)) as PayPalError;
    expect(err.status).toBe(404);
  });

  it("refuses partial payments for an Indian merchant and allows them elsewhere", async () => {
    const partial = { ...input, partialPayment: { minimumAmountDueMinor: 90000 } };
    await expect(paypal.createDraftInvoice(partial)).rejects.toThrow(/PARTIAL_PAYMENT_NOT_ALLOWED/);
    vi.stubEnv("PAYPAL_MOCK_COUNTRY", "US");
    await expect(paypal.createDraftInvoice(partial)).resolves.toMatchObject({ status: "DRAFT" });
  });

  it("runs Brightside's split plan end to end", async () => {
    const original = await sent();
    const plan = [
      { amountMinor: 90000, dueDate: new Date("2026-11-03") },
      { amountMinor: 90000, dueDate: new Date("2026-12-02") },
    ];
    const drafts = replacementDrafts("split_invoices", { currency: "GBP", invoiceNumber: "0001", items: input.items, totalMinor: 180000, paidMinor: 0 }, plan, input);
    const sentIds: string[] = [];
    const r = await executePlan(original, drafts, paypal, { drafted: async () => undefined, sent: async (id) => void sentIds.push(id), state: async () => undefined });
    expect(r.state).toBe("active");
    expect(mockInvoice(original)?.status).toBe("CANCELLED");
    expect(sentIds.map((id) => [mockInvoice(id)?.status, mockInvoice(id)?.amount.value])).toEqual([
      ["SENT", "900.00"],
      ["SENT", "900.00"],
    ]);
  });

  it("routes the Agent Toolkit tools to the mock", async () => {
    const id = await sent();
    const tools = toolkitTools();
    await tools.send_invoice_reminder.run({ invoice_id: id, note: "Friendly nudge" });
    await tools.record_payment_for_invoice.run({ invoice_id: id, method: "BANK_TRANSFER", payment_date: "2026-11-02", amount: { currency_code: "GBP", value: "1800.00" } });
    expect(await tools.get_invoice.run({ invoice_id: id })).toMatchObject({ status: "PAID" });
    expect(mockInvoice(id)?.reminders).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses to run in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => paypalMode()).toThrow(/refused in production/);
    vi.stubEnv("ALLOW_MOCK_IN_PROD", "false");
    expect(() => paypalMode()).toThrow(/refused in production/);
    vi.stubEnv("ALLOW_MOCK_IN_PROD", "true");
    expect(paypalMode()).toBe("mock");
  });
});
