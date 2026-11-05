import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4Content } from "@ai-sdk/provider";
import { gen } from "@/ai/test-utils";
import { DEMO_FIXTURES } from "@/ai/demo-fixtures";
import { proposeAction } from "@/ai/propose";
import type { Facts } from "@/ai/prompts/propose-action";
import { findFixture } from "@/ai/replay";
import { noReply } from "./cases";
import { DEFAULT_MANDATE, type Mandate } from "./mandate";
import { parseToolkitResult } from "./toolkit";
import { buildAgentTools, toAction, type GateContext, type GateHooks, type Proposal } from "./tools";

const NOW = new Date("2026-11-10T15:00:00Z"); // 10:00 in New York
const DAY = 86_400_000;

function ctx(mandate: Partial<Mandate> = {}, over: Partial<GateContext["mandate"]> = {}): GateContext {
  return {
    currency: "USD",
    approverEmail: "ap@acme.test",
    mandate: {
      mandate: { ...DEFAULT_MANDATE, autopilot: true, ...mandate },
      caseState: "open",
      confidence: 0.95,
      now: NOW,
      clientTimezone: "America/New_York",
      knownRecipients: ["dana@acme.test", "ap@acme.test"],
      invoice: { paypalInvoiceId: "INV2-1", status: "SENT", totalMinor: 240_000, paidMinor: 0, dueDate: new Date(NOW.getTime() - 9 * DAY) },
      ...over,
    },
  };
}

function fakeHooks() {
  const recorded: Proposal[] = [];
  const executed: string[] = [];
  const hooks: GateHooks = {
    record: async (p) => {
      recorded.push(p);
      return `p${recorded.length}`;
    },
    execute: async (_id, p) => {
      executed.push(p.toolName);
      return { ok: true };
    },
  };
  return { hooks, recorded, executed };
}

const call = (toolName: string, input: unknown): LanguageModelV4Content => ({
  type: "tool-call",
  toolCallId: `c-${toolName}`,
  toolName,
  input: JSON.stringify(input),
});

const facts = {} as Facts;
const promptInput = { facts, reason: "forgot", diagnosis: "", clientName: "Acme", freelancerName: "Aarav", thread: [] };

async function run(c: GateContext, steps: LanguageModelV4Content[][]) {
  const h = fakeHooks();
  const model = new MockLanguageModelV4({ doGenerate: steps.map(gen) });
  const result = await proposeAction(model, promptInput, buildAgentTools(c, h.hooks), () => h.recorded.length);
  return { ...h, result, model };
}

const nudge = { to: "client", tone: "friendly", subject: "Invoice", body: "Hi Dana, here's the link again. Aarav" };

describe("gated agent tools", () => {
  it("executes an action the mandate allows", async () => {
    const r = await run(ctx(), [[call("send_message", nudge)], [{ type: "text", text: "Sent a nudge." }]]);
    expect(r.recorded[0].result.verdict).toBe("allow");
    expect(r.executed).toEqual(["send_message"]);
    expect(r.result.rationale).toBe("Sent a nudge.");
  });

  it("queues instead of executing when approval is needed", async () => {
    const r = await run(ctx({ autopilot: false }), [[call("send_message", nudge)], [{ type: "text", text: "Queued." }]]);
    expect(r.recorded[0].result).toEqual({ verdict: "needs_approval", reasons: ["autopilot is off for this client"] });
    expect(r.executed).toEqual([]);
  });

  it("queues, and never sends, a reply that agrees to bank details or a switch to Wise (autopilot on, high confidence)", async () => {
    const yes = { ...nudge, body: "Hi, yes Wise is fine. My bank details are IBAN GB12 3456 7890 1234. Aarav" };
    const r = await run(ctx(), [[call("send_message", yes)], [{ type: "text", text: "Replied." }]]);
    expect(r.recorded[0].result.verdict).toBe("needs_approval");
    expect(r.recorded[0].result.reasons[0]).toMatch(/bank details or another way to pay/);
    expect(r.executed).toEqual([]);
  });

  it("never executes a denied action, and tells the model why", async () => {
    const r = await run(ctx(), [[call("send_message", { ...nudge, tone: "formal" })], [{ type: "text", text: "Denied." }]]);
    expect(r.recorded[0].result.verdict).toBe("deny");
    expect(r.executed).toEqual([]);
    const toolResult = JSON.stringify(r.model.doGenerateCalls[1].prompt);
    expect(toolResult).toContain("denied");
    expect(toolResult).toContain("exceeds");
  });

  it("gates toolkit PayPal tools too, with ClearDue's tone field", async () => {
    const reminder = { invoice_id: "INV2-1", tone: "friendly", note: "For AP", additional_recipients: ["stranger@x.test"] };
    const r = await run(ctx(), [[call("send_invoice_reminder", reminder)], [{ type: "text", text: "Done." }]]);
    expect(r.recorded[0].result).toEqual({ verdict: "deny", reasons: ["unknown recipients: stranger@x.test"] });
    expect(r.executed).toEqual([]);
  });

  it("denies a payment plan that doesn't sum to the outstanding amount", async () => {
    const plan = { instalments: [{ amount: "1000.00", due_date: "2026-11-11" }, { amount: "1000.00", due_date: "2026-12-10" }], tone: "friendly", message: "Split?" };
    const r = await run(ctx(), [[call("offer_payment_plan", plan)], [{ type: "text", text: "Denied." }]]);
    expect(r.recorded[0].result.reasons).toContain("instalments sum to 200000 but 240000 is outstanding");
  });

  it("does not retry once a tool has run (no double execution)", async () => {
    const h = fakeHooks();
    const model = new MockLanguageModelV4({
      doGenerate: vi
        .fn()
        .mockResolvedValueOnce(gen([call("send_message", nudge)]))
        .mockRejectedValueOnce(new Error("overloaded"))
        .mockResolvedValue(gen([call("send_message", nudge)])),
    });
    const result = await proposeAction(model, promptInput, buildAgentTools(ctx(), h.hooks), () => h.recorded.length);
    expect(result.error).toContain("overloaded");
    expect(h.executed).toEqual(["send_message"]);
  });

  it("retries once when the model fails before any tool ran", async () => {
    const h = fakeHooks();
    const model = new MockLanguageModelV4({
      doGenerate: vi
        .fn()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValueOnce(gen([call("send_message", nudge)]))
        .mockResolvedValue(gen([{ type: "text", text: "ok" }])),
    });
    const result = await proposeAction(model, promptInput, buildAgentTools(ctx(), h.hooks), () => h.recorded.length);
    expect(result.error).toBeUndefined();
    expect(h.executed).toEqual(["send_message"]);
  });
});

describe("toAction", () => {
  it("rejects messages to an approver that doesn't exist", () => {
    expect(() => toAction("send_message", { ...nudge, to: "approver" }, { ...ctx(), approverEmail: null })).toThrow(/no approver/);
  });
  it("rejects payments in another currency", () => {
    expect(() => toAction("record_payment_for_invoice", { invoice_id: "INV2-1", amount: { currency_code: "EUR", value: "10" } }, ctx())).toThrow(/USD/);
  });
});

describe("parseToolkitResult", () => {
  it("passes successful JSON through", () => {
    expect(parseToolkitResult("get_invoice", '{"id":"INV2-1","status":"SENT"}')).toEqual({ id: "INV2-1", status: "SENT" });
  });
  it("turns the toolkit's error envelopes into exceptions", () => {
    expect(() => parseToolkitResult("send_invoice_reminder", '{"error":{"message":"boom","type":"paypal_error"}}')).toThrow(/boom/);
    expect(() => parseToolkitResult("x", '{"name":"INVALID_REQUEST","message":"bad","debug_id":"d1"}')).toThrow(/INVALID_REQUEST/);
  });
});

describe("recorded demo actions pass the mandate against the seed data", () => {
  // Mirrors prisma/seed.mts: Acme (USD 2,400, 9 days overdue, AP contact) and Brightside (GBP 1,800, friendly ceiling).
  const factsFor = (outstanding: string, split: string[]) => ({
    invoice_id: "INV2-1",
    approver_email: "ap@acme.test",
    tomorrow: "2026-11-11",
    in_7_days: "2026-11-17",
    in_30_days: "2026-12-10",
    currency: "GBP",
    outstanding,
    suggested_split: split,
    pay_link: "http://localhost:3000/pay/x",
  });
  const replay = (match: string, f: object) =>
    (findFixture(DEMO_FIXTURES, { prompt: [{ role: "system", content: `[task:propose_action] ${match} FACTS ${JSON.stringify(f)}` }] } as never) ?? []).filter(
      (c) => c.type === "tool-call",
    );

  it("Acme: AP reminder and pause need approval only because autopilot is off", async () => {
    const steps = replay("waiting on finance sign-off", factsFor("2400.00", ["1200.00", "1200.00"]));
    const r = await run(ctx({ autopilot: false }), [steps, [{ type: "text", text: "ok" }]]);
    expect(r.recorded.map((p) => [p.toolName, p.result.verdict])).toEqual([
      ["send_invoice_reminder", "needs_approval"],
      ["pause_reminders", "needs_approval"],
    ]);
    expect(r.recorded.every((p) => p.result.reasons.join() === "autopilot is off for this client")).toBe(true);
  });

  it("Brightside: the 2-part plan is within the friendly-ceiling mandate", async () => {
    const steps = replay("Cash is tight this month", factsFor("1800.00", ["900.00", "900.00"]));
    const c = ctx({ autopilot: false, toneCeiling: "friendly" }, { invoice: { ...ctx().mandate.invoice, totalMinor: 180_000, dueDate: new Date(NOW.getTime() - 5 * DAY) } });
    const r = await run({ ...c, currency: "GBP" }, [steps, [{ type: "text", text: "ok" }]]);
    expect(r.recorded.map((p) => [p.toolName, p.result.verdict])).toEqual([["offer_payment_plan", "needs_approval"]]);
    expect(r.recorded[0].draft).toContain("900.00");
  });
});

describe("noReply", () => {
  it("labels silence as no_response, a fact rather than a guess", () => {
    const invoice = { dueDate: new Date("2026-10-24"), status: "SENT", totalMinor: 1, paidMinor: 0 } as Parameters<typeof noReply>[0];
    const d = noReply(invoice, new Date("2026-11-02T12:00:00Z"));
    expect(d).toMatchObject({ reason: "no_response", confidence: 1, evidence: [] });
    expect(d.summary).toContain("9 days overdue");
  });
});
