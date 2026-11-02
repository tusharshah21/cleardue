import { describe, expect, it, vi } from "vitest";
import { checkAction, DEFAULT_MANDATE, type Mandate, type MandateContext } from "@/agent/mandate";
import type { PayPalInvoice } from "@/paypal/invoices";
import { executePlan, PlanAborted, replacementDrafts, sendPending, strategyFor, suggestPlan, type PlanPayPal, type PlanStore } from "./plans";

const now = new Date("2026-11-02T10:00:00Z");
const due = new Date("2026-10-28T00:00:00Z");
const sum = (xs: { amountMinor: number }[]) => xs.reduce((s, x) => s + x.amountMinor, 0);

const planCtx = (mandate: Mandate, outstanding: number): MandateContext => ({
  mandate,
  caseState: "open",
  confidence: 1,
  now,
  clientTimezone: "UTC",
  knownRecipients: [],
  invoice: { paypalInvoiceId: "INV2-1", status: "SENT", totalMinor: outstanding, paidMinor: 0, dueDate: due },
});

describe("strategyFor", () => {
  it("uses split invoices where PayPal blocks partial payments", () => {
    expect(["IN", "br", "IL"].map(strategyFor)).toEqual(["split_invoices", "split_invoices", "split_invoices"]);
    expect(["US", "GB", "AU"].map(strategyFor)).toEqual(["partial_payment", "partial_payment", "partial_payment"]);
  });
});

describe("suggestPlan", () => {
  it("sums exactly for every count and awkward totals, and passes the mandate", () => {
    const mandate = { ...DEFAULT_MANDATE, maxInstalments: 4, minFirstPayment: { kind: "percent" as const, value: 0 } };
    for (const total of [180000, 100, 99999, 7]) {
      for (const n of [2, 3, 4]) {
        const plan = suggestPlan(total, mandate, due, now, n);
        if (total < n) {
          expect(plan).toBeNull();
          continue;
        }
        expect(sum(plan!)).toBe(total);
        expect(plan!.every((p) => Number.isInteger(p.amountMinor) && p.amountMinor > 0)).toBe(true);
        expect(checkAction({ type: "offer_plan", instalments: plan! }, planCtx({ ...mandate, autopilot: true }, total)).verdict).toBe("allow");
      }
    }
  });

  it("raises the first payment to the mandate minimum and splits the rest", () => {
    const plan = suggestPlan(100000, { ...DEFAULT_MANDATE, minFirstPayment: { kind: "percent", value: 50 } }, due, now, 3)!;
    expect(plan.map((p) => p.amountMinor)).toEqual([50000, 25000, 25000]);
    const byAmount = suggestPlan(1000, { ...DEFAULT_MANDATE, minFirstPayment: { kind: "amount", valueMinor: 700 } }, due, now, 2)!;
    expect(byAmount.map((p) => p.amountMinor)).toEqual([700, 300]);
  });

  it("rounds the percentage minimum up, in whole units for zero-decimal currencies", () => {
    // 30% of 1001 yen is 300.3, so the first part must be 301 to stay at or above the minimum.
    const plan = suggestPlan(1001, DEFAULT_MANDATE, due, now, 3)!;
    expect(plan[0].amountMinor).toBeGreaterThanOrEqual(301);
    expect(sum(plan)).toBe(1001);
  });

  it("starts today, keeps dates increasing and never passes the latest final date", () => {
    const plan = suggestPlan(90000, DEFAULT_MANDATE, due, now, 3)!;
    // Latest final date is due + 60 days = 2026-12-27, so the 60-day spread shrinks to 55 days.
    expect(plan.map((p) => p.dueDate.toISOString().slice(0, 10))).toEqual(["2026-11-02", "2026-11-30", "2026-12-27"]);
    const tight = suggestPlan(90000, { ...DEFAULT_MANDATE, maxPlanDays: 5 }, due, now, 2);
    expect(tight).toBeNull();
  });

  it("refuses counts outside the mandate", () => {
    expect(suggestPlan(90000, DEFAULT_MANDATE, due, now, 1)).toBeNull();
    expect(suggestPlan(90000, DEFAULT_MANDATE, due, now, 4)).toBeNull();
  });
});

const original = {
  currency: "GBP",
  invoiceNumber: "0007",
  items: [
    { name: "Webflow build", quantity: 1, unitAmountMinor: 150000, unit: "AMOUNT" as const },
    { name: "CMS setup", quantity: 1, unitAmountMinor: 30000, unit: "AMOUNT" as const },
  ],
  totalMinor: 180000,
  paidMinor: 0,
};
const parties = { invoicerBusinessName: "Aarav Mehta Design", recipientEmail: "sam@brightside.test", recipientName: "Brightside Studio" };
const plan = [
  { amountMinor: 90001, dueDate: new Date("2026-11-03") },
  { amountMinor: 89999, dueDate: new Date("2026-12-02") },
];

describe("replacementDrafts", () => {
  it("split_invoices: one invoice per instalment, amounts and dates exact", () => {
    const drafts = replacementDrafts("split_invoices", original, plan, parties);
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.items[0].unitAmountMinor)).toEqual([90001, 89999]);
    expect(drafts.map((d) => d.dueDate)).toEqual(plan.map((p) => p.dueDate));
    expect(drafts[0].items[0].name).toBe("Instalment 1 of 2");
    expect(drafts.every((d) => !d.partialPayment && d.recipientEmail === parties.recipientEmail)).toBe(true);
  });

  it("partial_payment: one invoice with the original items and the first instalment as minimum", () => {
    const [d] = replacementDrafts("partial_payment", original, plan, parties);
    expect(d.items).toEqual(original.items);
    expect(d.partialPayment).toEqual({ minimumAmountDueMinor: 90001 });
    expect(d.dueDate).toEqual(plan[1].dueDate);
  });

  it("refuses plans that don't add up or would double-bill", () => {
    expect(() => replacementDrafts("split_invoices", original, [{ ...plan[0] }, { ...plan[1], amountMinor: 1 }], parties)).toThrow(/sums to/);
    expect(() => replacementDrafts("split_invoices", { ...original, paidMinor: 100 }, plan, parties)).toThrow(/partly paid/);
  });
});

function fakes(originalStatus: Partial<PayPalInvoice> = { status: "SENT" }) {
  let n = 0;
  const api = {
    getInvoice: vi.fn(async (id: string) => ({ id, detail: { currency_code: "GBP" }, ...originalStatus }) as PayPalInvoice),
    createDraftInvoice: vi.fn(async () => ({ id: `NEW-${++n}`, status: "DRAFT", detail: { currency_code: "GBP" } })),
    sendInvoice: vi.fn(async (id: string) => ({ payerViewUrl: `https://pay/${id}` })),
    cancelInvoice: vi.fn(async () => undefined),
    deleteDraftInvoice: vi.fn(async () => undefined),
  } satisfies PlanPayPal;
  const log: string[] = [];
  const store: PlanStore = {
    drafted: async (d) => void log.push(`drafted ${d.map((x) => x.paypalInvoiceId).join(",")}`),
    sent: async (id) => void log.push(`sent ${id}`),
    state: async (s, err) => void log.push(`state ${s}${err ? `: ${err}` : ""}`),
  };
  return { api, store, log };
}

describe("executePlan", () => {
  const drafts = replacementDrafts("split_invoices", original, plan, parties);

  it("drafts, re-checks, cancels silently, then sends", async () => {
    const { api, store, log } = fakes();
    await expect(executePlan("ORIG", drafts, api, store)).resolves.toEqual({ state: "active", errors: [] });
    expect(api.cancelInvoice).toHaveBeenCalledWith("ORIG", expect.objectContaining({ sendToRecipient: false }));
    expect(log).toEqual(["drafted NEW-1,NEW-2", "state pending_send", "sent NEW-1", "sent NEW-2", "state active"]);
    // The re-check happens after drafting and before the cancel.
    expect(api.getInvoice.mock.invocationCallOrder[0]).toBeGreaterThan(api.createDraftInvoice.mock.invocationCallOrder[1]);
    expect(api.getInvoice.mock.invocationCallOrder[0]).toBeLessThan(api.cancelInvoice.mock.invocationCallOrder[0]);
  });

  it.each([
    ["paid", { status: "PAID" }],
    ["partly paid", { status: "PARTIALLY_PAID" }],
    ["paid amount on a SENT invoice", { status: "SENT", payments: { paid_amount: { currency_code: "GBP", value: "10.00" } } }],
  ])("aborts without cancelling when the original is %s", async (_, status) => {
    const { api, store, log } = fakes(status);
    await expect(executePlan("ORIG", drafts, api, store)).rejects.toBeInstanceOf(PlanAborted);
    expect(api.cancelInvoice).not.toHaveBeenCalled();
    expect(api.sendInvoice).not.toHaveBeenCalled();
    expect(api.deleteDraftInvoice).toHaveBeenCalledTimes(2);
    expect(log.at(-1)).toMatch(/^state aborted/);
  });

  it("cleans up created drafts when a later draft fails", async () => {
    const { api, store } = fakes();
    api.createDraftInvoice.mockResolvedValueOnce({ id: "NEW-A", status: "DRAFT", detail: { currency_code: "GBP" } }).mockRejectedValueOnce(new Error("422"));
    await expect(executePlan("ORIG", drafts, api, store)).rejects.toThrow(/Could not create/);
    expect(api.deleteDraftInvoice).toHaveBeenCalledWith("NEW-A");
    expect(api.cancelInvoice).not.toHaveBeenCalled();
  });

  it("keeps the original if the cancel fails", async () => {
    const { api, store } = fakes();
    api.cancelInvoice.mockRejectedValueOnce(new Error("boom"));
    await expect(executePlan("ORIG", drafts, api, store)).rejects.toThrow(/Could not cancel/);
    expect(api.sendInvoice).not.toHaveBeenCalled();
  });

  it("stays pending_send after a failed send, and a retry finishes it", async () => {
    const { api, store, log } = fakes();
    api.sendInvoice.mockRejectedValueOnce(new Error("timeout"));
    const r = await executePlan("ORIG", drafts, api, store);
    expect(r.state).toBe("pending_send");
    expect(log.at(-1)).toMatch(/^state pending_send: NEW-1: timeout/);
    await expect(sendPending(["NEW-1"], api, store)).resolves.toEqual({ state: "active", errors: [] });
  });
});
