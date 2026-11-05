import { describe, expect, it } from "vitest";
import {
  checkAction,
  DEFAULT_MANDATE,
  effectiveMandate,
  exceedsTone,
  hourIn,
  inQuietHours,
  type AgentAction,
  type Mandate,
  type MandateContext,
} from "./mandate";

const DAY = 86_400_000;
// 2026-11-10 15:00 UTC = 10:00 in New York: outside default quiet hours.
const NOW = new Date("2026-11-10T15:00:00Z");
const d = (days: number) => new Date(NOW.getTime() + days * DAY);

function ctx(over: Partial<MandateContext> = {}, mandate: Partial<Mandate> = {}): MandateContext {
  return {
    mandate: { ...DEFAULT_MANDATE, autopilot: true, ...mandate },
    caseState: "open",
    confidence: 0.95,
    now: NOW,
    clientTimezone: "America/New_York",
    knownRecipients: ["client@acme.test", "ap@acme.test"],
    invoice: { paypalInvoiceId: "INV2-1", status: "SENT", totalMinor: 100_000, paidMinor: 0, dueDate: d(-5) },
    ...over,
  };
}

const reminder = (over: Partial<Extract<AgentAction, { type: "send_reminder" }>> = {}): AgentAction => ({
  type: "send_reminder",
  invoiceId: "INV2-1",
  tone: "friendly",
  note: "Quick nudge",
  additionalRecipients: [],
  ...over,
});
const message = (over: Partial<Extract<AgentAction, { type: "send_message" }>> = {}): AgentAction => ({
  type: "send_message",
  to: "client",
  tone: "friendly",
  body: "Hi there",
  ...over,
});
const plan = (...parts: [number, number][]): AgentAction => ({
  type: "offer_plan",
  instalments: parts.map(([amountMinor, days]) => ({ amountMinor, dueDate: d(days) })),
});

describe("effectiveMandate", () => {
  it("uses defaults when nothing is stored", () => {
    expect(effectiveMandate(null, null)).toEqual(DEFAULT_MANDATE);
  });
  it("applies client overrides field by field", () => {
    const m = effectiveMandate(DEFAULT_MANDATE, { toneCeiling: "friendly", autopilot: true });
    expect(m).toEqual({ ...DEFAULT_MANDATE, toneCeiling: "friendly", autopilot: true });
  });
  it("rejects invalid stored mandates", () => {
    expect(() => effectiveMandate({ ...DEFAULT_MANDATE, minConfidence: 2 }, null)).toThrow();
    expect(() => effectiveMandate(DEFAULT_MANDATE, { toneCeiling: "angry" })).toThrow();
  });
});

describe("helpers", () => {
  it("orders tones friendly < firm < formal", () => {
    expect(exceedsTone("firm", "friendly")).toBe(true);
    expect(exceedsTone("formal", "firm")).toBe(true);
    expect(exceedsTone("friendly", "formal")).toBe(false);
    expect(exceedsTone("firm", "firm")).toBe(false);
  });
  it("reads the hour in the client's timezone", () => {
    expect(hourIn("America/New_York", NOW)).toBe(10);
    expect(hourIn("Asia/Kolkata", NOW)).toBe(20);
  });
  it("handles quiet hours that wrap midnight, same-day windows, and none", () => {
    const wrap = { start: 20, end: 8 };
    expect(inQuietHours(wrap, "UTC", new Date("2026-11-10T21:00:00Z"))).toBe(true);
    expect(inQuietHours(wrap, "UTC", new Date("2026-11-10T07:59:00Z"))).toBe(true);
    expect(inQuietHours(wrap, "UTC", new Date("2026-11-10T08:00:00Z"))).toBe(false);
    const sameDay = { start: 12, end: 14 };
    expect(inQuietHours(sameDay, "UTC", new Date("2026-11-10T13:00:00Z"))).toBe(true);
    expect(inQuietHours(sameDay, "UTC", new Date("2026-11-10T14:00:00Z"))).toBe(false);
    expect(inQuietHours({ start: 9, end: 9 }, "UTC", NOW)).toBe(false);
  });
});

describe("checkAction: contact actions", () => {
  it("allows a friendly reminder within mandate", () => {
    expect(checkAction(reminder(), ctx())).toEqual({ verdict: "allow", reasons: ["within mandate; outside quiet hours"] });
  });
  it("denies a tone above the ceiling", () => {
    const r = checkAction(reminder({ tone: "formal" }), ctx());
    expect(r.verdict).toBe("deny");
    expect(r.reasons[0]).toMatch(/exceeds/);
  });
  it("denies empty messages", () => {
    expect(checkAction(message({ body: "  " }), ctx()).verdict).toBe("deny");
    expect(checkAction(reminder({ note: "" }), ctx()).verdict).toBe("deny");
  });
  it("denies reminders to unknown addresses but allows the approver", () => {
    expect(checkAction(reminder({ additionalRecipients: ["AP@acme.test"] }), ctx()).verdict).toBe("allow");
    const r = checkAction(reminder({ additionalRecipients: ["random@evil.test"] }), ctx());
    expect(r).toEqual({ verdict: "deny", reasons: ["unknown recipients: random@evil.test"] });
  });
  it("denies reminders on invoices that are not open", () => {
    expect(checkAction(reminder(), ctx({ invoice: { ...ctx().invoice, status: "PAID" } })).verdict).toBe("deny");
  });
  it("denies actions on a different invoice, or when the invoice isn't on PayPal", () => {
    expect(checkAction(reminder({ invoiceId: "INV2-OTHER" }), ctx()).reasons).toContain("action targets a different invoice");
    const local = ctx({ invoice: { ...ctx().invoice, paypalInvoiceId: null } });
    expect(checkAction(reminder({ invoiceId: "" }), local).reasons).toContain("invoice is not on PayPal yet");
  });
  it("needs approval for never-auto-contact clients", () => {
    const r = checkAction(message(), ctx({}, { neverAutoContact: true }));
    expect(r).toEqual({ verdict: "needs_approval", reasons: ["client is marked never-auto-contact"] });
  });
  it("needs approval inside quiet hours (client timezone)", () => {
    const r = checkAction(message(), ctx({ now: new Date("2026-11-11T03:00:00Z") })); // 22:00 New York
    expect(r).toEqual({ verdict: "needs_approval", reasons: ["inside the client's quiet hours"] });
  });
  it("needs approval when autopilot is off or confidence is low", () => {
    expect(checkAction(message(), ctx({}, { autopilot: false })).reasons).toEqual(["autopilot is off for this client"]);
    expect(checkAction(message(), ctx({ confidence: 0.6 })).reasons).toEqual(["confidence 0.60 is below 0.85"]);
  });
  it("deny wins over needs_approval", () => {
    expect(checkAction(message({ tone: "formal" }), ctx({ confidence: 0.1 })).verdict).toBe("deny");
  });
});

describe("checkAction: payment rails (bank details, Wise, UPI)", () => {
  const reason = "Held for you: mentions bank details or a payment method";
  it.each([
    "Sure, Wise works for us. My bank details: IBAN GB12 3456 7890 1234",
    "Happy to take a bank transfer instead, here is my account number 12345678",
    "You can pay me directly on UPI to skip the PayPal fees",
    "Yes, we can switch to Payoneer.",
  ])("holds %j for the freelancer even with autopilot on and high confidence", (body) => {
    expect(checkAction(message({ body }), ctx())).toEqual({ verdict: "needs_approval", reasons: [reason] });
    expect(checkAction(reminder({ note: body }), ctx())).toEqual({ verdict: "needs_approval", reasons: [reason] });
  });
  it("holds a payment plan message that offers another way to pay", () => {
    const plan = (message?: string): AgentAction => ({ type: "offer_plan", message, instalments: [{ amountMinor: 50_000, dueDate: d(1) }, { amountMinor: 50_000, dueDate: d(30) }] });
    expect(checkAction(plan("Two parts, and Wise is fine for the second"), ctx()).verdict).toBe("needs_approval");
    expect(checkAction(plan("Two parts, each paid through the PayPal link"), ctx()).verdict).toBe("allow");
  });
  it("still allows an ordinary nudge", () => {
    expect(checkAction(message({ body: "Hi Dana, here is the PayPal link again. Thanks! Aarav" }), ctx()).verdict).toBe("allow");
  });
});

describe("checkAction: case state", () => {
  it("in dispute, replies become drafts and everything else stops", () => {
    expect(checkAction(message(), ctx({ caseState: "dispute" }))).toEqual({
      verdict: "needs_approval",
      reasons: ["case is in dispute; replies are drafts for the freelancer to review"],
    });
    expect(checkAction(reminder(), ctx({ caseState: "dispute" })).verdict).toBe("deny");
    expect(checkAction(plan([50_000, 1], [50_000, 20]), ctx({ caseState: "dispute" })).verdict).toBe("deny");
    expect(checkAction({ type: "escalate_to_freelancer", summary: "x" }, ctx({ caseState: "dispute" })).verdict).toBe("allow");
  });
  it("a resolved case only allows reads", () => {
    expect(checkAction(message(), ctx({ caseState: "resolved" })).verdict).toBe("deny");
    expect(checkAction({ type: "escalate_to_freelancer", summary: "x" }, ctx({ caseState: "resolved" })).verdict).toBe("deny");
    expect(checkAction({ type: "read_invoice", invoiceId: "INV2-1" }, ctx({ caseState: "resolved" })).verdict).toBe("allow");
  });
});

describe("checkAction: internal actions", () => {
  it("allows reads and escalations even with autopilot off and low confidence", () => {
    const c = ctx({ confidence: 0.1 }, { autopilot: false });
    expect(checkAction({ type: "read_invoice", invoiceId: "INV2-1" }, c)).toEqual({ verdict: "allow", reasons: ["within mandate"] });
    expect(checkAction({ type: "escalate_to_freelancer", summary: "Client disputes line 2" }, c).verdict).toBe("allow");
  });
});

describe("checkAction: pause_reminders", () => {
  it("allows a future pause within the plan window", () => {
    expect(checkAction({ type: "pause_reminders", until: d(7) }, ctx()).verdict).toBe("allow");
  });
  it("denies pauses in the past or today", () => {
    expect(checkAction({ type: "pause_reminders", until: d(0) }, ctx()).verdict).toBe("deny");
  });
  it("denies pauses past due date + maxPlanDays", () => {
    const r = checkAction({ type: "pause_reminders", until: d(56) }, ctx()); // due -5 + 60 = 55
    expect(r.reasons[0]).toMatch(/past 60 days/);
    expect(checkAction({ type: "pause_reminders", until: d(55) }, ctx()).verdict).toBe("allow");
  });
});

describe("checkAction: offer_plan", () => {
  it("allows a 2-part plan that sums exactly and respects the minimum first payment", () => {
    expect(checkAction(plan([50_000, 1], [50_000, 30]), ctx()).verdict).toBe("allow");
  });
  it("accepts a first payment exactly at the percent minimum", () => {
    expect(checkAction(plan([30_000, 1], [70_000, 30]), ctx()).verdict).toBe("allow");
    expect(checkAction(plan([29_999, 1], [70_001, 30]), ctx()).reasons).toContain("first payment is below the 30% minimum");
  });
  it("supports an absolute minimum first payment", () => {
    const c = ctx({}, { minFirstPayment: { kind: "amount", valueMinor: 40_000 } });
    expect(checkAction(plan([40_000, 1], [60_000, 30]), c).verdict).toBe("allow");
    expect(checkAction(plan([39_999, 1], [60_001, 30]), c).reasons).toContain("first payment is below the 40000 minimum");
  });
  it("uses the outstanding amount after partial payments", () => {
    const c = ctx({ invoice: { ...ctx().invoice, status: "PARTIALLY_PAID", paidMinor: 40_000 } });
    expect(checkAction(plan([30_000, 1], [30_000, 20]), c).verdict).toBe("allow");
    expect(checkAction(plan([50_000, 1], [50_000, 20]), c).reasons).toContain("instalments sum to 100000 but 60000 is outstanding");
  });
  it("denies too few or too many instalments", () => {
    expect(checkAction(plan([100_000, 1]), ctx()).reasons).toContain("a plan needs at least 2 instalments");
    const four = plan([40_000, 1], [20_000, 10], [20_000, 20], [20_000, 30]);
    expect(checkAction(four, ctx()).reasons).toContain("plan has 4 instalments; mandate allows 3");
  });
  it("denies non-positive or fractional amounts", () => {
    expect(checkAction(plan([100_000, 1], [0, 10]), ctx()).reasons).toContain("every instalment must be a positive whole minor-unit amount");
    expect(checkAction(plan([50_000.5, 1], [49_999.5, 10]), ctx()).reasons).toContain("every instalment must be a positive whole minor-unit amount");
  });
  it("denies non-increasing dates, past starts, and late finishes", () => {
    expect(checkAction(plan([50_000, 10], [50_000, 10]), ctx()).reasons).toContain("instalment dates must be strictly increasing");
    expect(checkAction(plan([50_000, -1], [50_000, 10]), ctx()).reasons).toContain("first instalment is in the past");
    expect(checkAction(plan([50_000, 1], [50_000, 56]), ctx()).reasons[0]).toMatch(/final instalment is later/);
  });
  it("denies a plan on a closed invoice and an empty plan", () => {
    expect(checkAction(plan([50_000, 1], [50_000, 20]), ctx({ invoice: { ...ctx().invoice, status: "CANCELLED" } })).reasons).toContain(
      "invoice is CANCELLED; no plan possible",
    );
    expect(checkAction({ type: "offer_plan", instalments: [] }, ctx()).verdict).toBe("deny");
  });
  it("needs approval when autopilot is off even if the plan is valid", () => {
    expect(checkAction(plan([50_000, 1], [50_000, 30]), ctx({}, { autopilot: false })).verdict).toBe("needs_approval");
  });
});

describe("checkAction: money actions that always need the freelancer", () => {
  it("cancel needs approval even on autopilot", () => {
    expect(checkAction({ type: "cancel_invoice", invoiceId: "INV2-1" }, ctx())).toEqual({
      verdict: "needs_approval",
      reasons: ["cancelling an invoice always needs the freelancer"],
    });
  });
  it("cancel is denied once any money has arrived", () => {
    expect(checkAction({ type: "cancel_invoice", invoiceId: "INV2-1" }, ctx({ invoice: { ...ctx().invoice, status: "PAID" } })).verdict).toBe("deny");
    expect(checkAction({ type: "cancel_invoice", invoiceId: "INV2-1" }, ctx({ invoice: { ...ctx().invoice, paidMinor: 1 } })).verdict).toBe("deny");
  });
  it("record_payment needs approval and is bounded by the outstanding amount", () => {
    expect(checkAction({ type: "record_payment", invoiceId: "INV2-1", amountMinor: 100_000 }, ctx()).verdict).toBe("needs_approval");
    expect(checkAction({ type: "record_payment", invoiceId: "INV2-1", amountMinor: 100_001 }, ctx()).verdict).toBe("deny");
    expect(checkAction({ type: "record_payment", invoiceId: "INV2-1", amountMinor: 0 }, ctx()).verdict).toBe("deny");
  });
});

describe("a misread reply fails safe", () => {
  // The two misses in the 2026-11-03 synthetic eval: "Thanks for the update." (confidence 0.5) and
  // "Let me check and get back to you." (0.8), both read as `forgot`, whose action is a friendly nudge.
  it.each([0.5, 0.8])("holds a friendly nudge for approval at confidence %s even with autopilot on, outside quiet hours", (confidence) => {
    for (const action of [message(), reminder()]) {
      const r = checkAction(action, ctx({ confidence }));
      expect(r.verdict).toBe("needs_approval");
      expect(r.reasons.join(" ")).toContain(`confidence ${confidence.toFixed(2)} is below 0.85`);
    }
  });
});
