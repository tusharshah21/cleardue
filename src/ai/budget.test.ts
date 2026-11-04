import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { Budget } from "./budget";
import { proposeAction } from "./propose";
import { failover, labelProvider, retryTransient } from "./replay";
import { classifyReply, payerAssistant, scopeCheck } from "./tasks";
import { gen } from "./test-utils";

const input = { clientName: "Acme Labs", invoiceSummary: "$2,400 outstanding", thread: [{ from: "client" as const, at: new Date("2026-11-02"), body: "Waiting on finance." }] };
const good = { reason: "awaiting_approval", confidence: 0.9, evidence: ["Waiting on finance"], promisedDate: null, approverEmail: null, summary: "In approval." };
const ok = () => gen([{ type: "text", text: JSON.stringify(good) }]);

/** A provider that never answers: it only ends when its abort signal fires, like a stuck HTTP call. */
const hung = () =>
  new MockLanguageModelV4({
    doGenerate: ({ abortSignal }) =>
      new Promise((_, reject) => {
        if (abortSignal?.aborted) reject(abortSignal.reason);
        abortSignal?.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
      }),
  });
const limited = () => new MockLanguageModelV4({ doGenerate: async () => Promise.reject(Object.assign(new Error("rate limit"), { statusCode: 429 })) });
const timed = async <T>(run: () => Promise<T>) => {
  const t = Date.now();
  const value = await run();
  return { value, ms: Date.now() - t };
};

describe("Budget", () => {
  it("counts down on its clock and caps each call's signal at what is left", () => {
    let now = 1_000;
    const b = new Budget(45_000, () => now);
    expect(b.remainingMs()).toBe(45_000);
    now += 44_000;
    expect(b.remainingMs()).toBe(1_000);
    expect(b.exhausted()).toBe(false);
    now += 5_000;
    expect(b.remainingMs()).toBe(0);
    expect(b.exhausted()).toBe(true);
  });
});

describe("time budget per action", () => {
  it("a hung provider ends the action at the budget with the readable fallback, not after two full timeouts", async () => {
    const { value, ms } = await timed(() => classifyReply(hung(), { ...input, budget: new Budget(300) }));
    expect(value.fallback).toBe(true);
    expect(value.value.reason).toBe("other");
    expect(ms).toBeLessThan(1_500);
  });

  it("does not start a call once the budget is spent", async () => {
    const model = new MockLanguageModelV4({ doGenerate: ok() });
    let now = 0;
    const spent = new Budget(10, () => now);
    now = 11;
    const r = await classifyReply(model, { ...input, budget: spent });
    expect(r.fallback).toBe(true);
    expect(r.error).toMatch(/time budget/);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("scope check and pay-page answers fall back readably when the model hangs (20 s default, shortened here by a spent clock)", async () => {
    const scope = await scopeCheck(new MockLanguageModelV4({ doGenerate: async () => Promise.reject(new Error("The operation was aborted due to timeout")) }), { scope: "Landing page", request: "Add a blog" });
    expect(scope.value.verdict).toBe("GRAY_ZONE");
    const answer = await payerAssistant(new MockLanguageModelV4({ doGenerate: async () => Promise.reject(new Error("The operation was aborted due to timeout")) }), {
      freelancerName: "Priya",
      sources: { scope: "s", invoice: "i", thread: "t" },
      question: "Why this amount?",
    });
    expect(answer.value.escalate).toBe(true);
  });

  it("the backoff retry does not outlive the budget", async () => {
    const never = () => new Promise<void>(() => {});
    const { value, ms } = await timed(() => classifyReply(retryTransient(limited(), never), { ...input, budget: new Budget(200) }));
    expect(value.fallback).toBe(true);
    expect(ms).toBeLessThan(1_500);
  });

  it("failover tries the secondary when the primary hangs past its slice, inside the same budget", async () => {
    const secondary = labelProvider(new MockLanguageModelV4({ doGenerate: ok() }), "google/gemini-x");
    const { value, ms } = await timed(() => classifyReply(failover(hung(), secondary, 100), { ...input, budget: new Budget(2_000) }));
    expect(value.fallback).toBe(false);
    expect(value.provider).toBe("google/gemini-x");
    expect(ms).toBeLessThan(1_500);
  });

  it("failover does not start the secondary after the budget is gone", async () => {
    const secondary = new MockLanguageModelV4({ doGenerate: ok() });
    const { value } = await timed(() => classifyReply(failover(hung(), secondary, 10_000), { ...input, budget: new Budget(100) }));
    expect(value.fallback).toBe(true);
    expect(secondary.doGenerateCalls).toHaveLength(0);
  });

  it("the whole worst case (retry, failover, second attempt) stays inside a 45 s style budget, scaled down", async () => {
    // Both providers hang; a 400 ms budget stands in for 45 s. Total time must track the budget, not attempts x timeout.
    const { value, ms } = await timed(() => classifyReply(failover(retryTransient(hung(), async () => {}), retryTransient(hung(), async () => {}), 100), { ...input, budget: new Budget(400) }));
    expect(value.fallback).toBe(true);
    expect(ms).toBeLessThan(1_500);
  });

  it("proposeAction stops without calling the model when the diagnosis already used its budget", async () => {
    const model = new MockLanguageModelV4({ doGenerate: ok() });
    let now = 0;
    const spent = new Budget(10, () => now);
    now = 11;
    const r = await proposeAction(model, { facts: "{}", reason: "forgot", diagnosis: "", clientName: "A", freelancerName: "B", thread: [] } as never, {}, () => 0, spent);
    expect(r.error).toMatch(/time budget/);
    expect(model.doGenerateCalls).toHaveLength(0);
  });
});
