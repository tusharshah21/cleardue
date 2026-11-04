import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { DEMO_FIXTURES } from "./demo-fixtures";
import { TASK_TAG as CLASSIFY } from "./prompts/classify-reply";
import { failover, findFixture, labelProvider, replayModel, replayOnTransient, retryTransient, unavailableModel } from "./replay";
import { providerName } from "@/lib/provider-name";
import { ClassifyReplySchema, type ClassifyReply } from "./schemas";
import { classifyReply, groundClassification, type ThreadMessage } from "./tasks";
import { gen } from "./test-utils";

const textOf = (v: unknown) => gen([{ type: "text", text: JSON.stringify(v) }]);

const thread: ThreadMessage[] = [
  { from: "freelancer", at: new Date("2026-11-01"), body: "Friendly reminder about the invoice." },
  { from: "client", at: new Date("2026-11-02"), body: "Sorry, waiting on finance sign-off, should clear next week." },
];
const good: ClassifyReply = {
  reason: "awaiting_approval",
  confidence: 0.9,
  evidence: ["waiting on finance sign-off"],
  promisedDate: null,
  approverEmail: null,
  summary: "Stuck in finance approval.",
};
const input = { clientName: "Acme Labs", invoiceSummary: "$2,400 outstanding", thread };

describe("classifyReply", () => {
  it("returns a validated classification, marked live", async () => {
    const r = await classifyReply(new MockLanguageModelV4({ doGenerate: textOf(good) }), input);
    expect(r).toEqual({ value: good, fallback: false, replayed: false, cached: false });
  });

  it("marks a DEMO_MODE replay as replayed", async () => {
    const live = new MockLanguageModelV4({ doGenerate: textOf(good) });
    const r = await classifyReply(replayModel(DEMO_FIXTURES, live), input);
    expect(r.replayed).toBe(true);
    expect(live.doGenerateCalls).toHaveLength(0);
  });

  it("retries once after invalid output, then succeeds", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textOf({ reason: "banana" }), textOf(good)] });
    const r = await classifyReply(model, input);
    expect(r.fallback).toBe(false);
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("falls back to other with zero confidence after two failures", async () => {
    const model = new MockLanguageModelV4({ doGenerate: [textOf({ nope: 1 }), gen([{ type: "text", text: "not json" }])] });
    const r = await classifyReply(model, input);
    expect(r.fallback).toBe(true);
    expect(r.value.reason).toBe("other");
    expect(r.value.confidence).toBe(0);
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it("falls back readably when no model is configured", async () => {
    const r = await classifyReply(unavailableModel("ANTHROPIC_API_KEY is not set"), input);
    expect(r.value.summary).toContain("ANTHROPIC_API_KEY is not set");
  });
});

describe("groundClassification", () => {
  it("drops invented evidence and caps confidence when nothing is left", () => {
    const r = groundClassification({ ...good, evidence: ["we will never pay"], confidence: 0.99 }, thread);
    expect(r.evidence).toEqual([]);
    expect(r.confidence).toBe(0.5);
  });
  it("keeps quotes regardless of case, quotes and whitespace", () => {
    const r = groundClassification({ ...good, evidence: ['"Waiting on  finance sign-off"'] }, thread);
    expect(r.evidence).toHaveLength(1);
    expect(r.confidence).toBe(0.9);
  });
  it("never accepts the freelancer's own words as evidence", () => {
    expect(groundClassification({ ...good, evidence: ["Friendly reminder"] }, thread).evidence).toEqual([]);
  });
});

describe("DEMO_MODE replay", () => {
  const call = (text: string, assistantTurns = 0) => ({
    prompt: [
      { role: "system" as const, content: text },
      ...Array.from({ length: assistantTurns }, () => ({ role: "assistant" as const, content: [] })),
    ],
  });

  it("matches by task tag and phrase, and fills FACTS placeholders", () => {
    const facts = { invoice_id: "INV2-ABC", approver_email: "ap@acme.test", in_7_days: "2026-11-17" };
    const content = findFixture(DEMO_FIXTURES, call(`[task:propose_action] waiting on finance sign-off FACTS ${JSON.stringify(facts)}`) as never);
    const toolCall = content?.find((c) => c.type === "tool-call");
    expect(toolCall && JSON.parse(toolCall.input)).toMatchObject({ invoice_id: "INV2-ABC", additional_recipients: ["ap@acme.test"] });
  });

  it("returns the next step after a tool round-trip", () => {
    const content = findFixture(DEMO_FIXTURES, call("[task:propose_action] waiting on finance sign-off FACTS {}", 1) as never);
    expect(content?.[0].type).toBe("text");
  });

  it("recorded classifications are valid against the schema", () => {
    for (const f of DEMO_FIXTURES.filter((f) => f.task === CLASSIFY)) {
      const part = f.steps[0][0];
      expect(part.type).toBe("text");
      if (part.type === "text") expect(() => ClassifyReplySchema.parse(JSON.parse(part.text))).not.toThrow();
    }
  });

  it("falls through to the live model for anything else", async () => {
    const live = new MockLanguageModelV4({ doGenerate: textOf(good) });
    const r = await classifyReply(replayModel(DEMO_FIXTURES, live), {
      ...input,
      thread: [{ from: "client", at: new Date(), body: "Who is this?" }],
    });
    expect(live.doGenerateCalls).toHaveLength(1);
    expect(r.fallback).toBe(false);
  });
});

describe("rate limits and overload (429 / RESOURCE_EXHAUSTED, 503 UNAVAILABLE)", () => {
  const limited = () => Object.assign(new Error("RESOURCE_EXHAUSTED: quota exceeded"), { statusCode: 429 });
  const alwaysLimited = () => new MockLanguageModelV4({ doGenerate: async () => Promise.reject(limited()) });
  const noWait = async () => {};
  const sawAcme = { ...input, thread: [{ from: "client" as const, at: new Date(), body: "Sorry, waiting on finance sign-off, should clear next week." }] };

  it("retries once after a backoff and returns the live answer", async () => {
    let calls = 0;
    const live = new MockLanguageModelV4({ doGenerate: async () => (++calls === 1 ? Promise.reject(limited()) : textOf(good)) });
    const waits: number[] = [];
    const r = await classifyReply(retryTransient(live, async (ms) => void waits.push(ms)), input);
    expect(calls).toBe(2);
    expect(waits).toEqual([4000]);
    expect(r).toEqual({ value: good, fallback: false, replayed: false, cached: false });
  });

  it("honours Retry-After, capped at 10 seconds", async () => {
    const waits: number[] = [];
    const slow = Object.assign(limited(), { responseHeaders: { "retry-after": "60" } });
    let calls = 0;
    const live = new MockLanguageModelV4({ doGenerate: async () => (++calls === 1 ? Promise.reject(slow) : textOf(good)) });
    await classifyReply(retryTransient(live, async (ms) => void waits.push(ms)), input);
    expect(waits).toEqual([10_000]);
  });

  it("does not wait for a spent daily quota: straight to the recorded response", async () => {
    const spent = Object.assign(new Error("Quota exceeded: requests per day limit exceeded on Free Tier. Please retry in 1h29m23s."), { statusCode: 429 });
    const waits: number[] = [];
    const live = retryTransient(new MockLanguageModelV4({ doGenerate: async () => Promise.reject(spent) }), async (ms) => void waits.push(ms));
    const r = await classifyReply(replayOnTransient(DEMO_FIXTURES, live), sawAcme);
    expect(waits).toEqual([]);
    expect(r.replayed).toBe(true);
  });

  it("treats Gemini's 503 high-demand overload the same way", async () => {
    const overloaded = Object.assign(new Error("This model is currently experiencing high demand."), { statusCode: 503 });
    let calls = 0;
    const live = new MockLanguageModelV4({ doGenerate: async () => (++calls === 1 ? Promise.reject(overloaded) : textOf(good)) });
    const r = await classifyReply(retryTransient(live, noWait), input);
    expect(calls).toBe(2);
    expect(r.fallback).toBe(false);
  });

  it("does not retry other errors", async () => {
    const live = new MockLanguageModelV4({ doGenerate: async () => Promise.reject(new Error("bad request")) });
    await classifyReply(retryTransient(live, noWait), input);
    expect(live.doGenerateCalls.length).toBeLessThanOrEqual(2); // structured()'s own single retry, not ours
  });

  it("serves the recorded response for a seed story when still rate-limited, labelled as replayed", async () => {
    const live = retryTransient(alwaysLimited(), noWait);
    const r = await classifyReply(replayOnTransient(DEMO_FIXTURES, live), sawAcme);
    expect(r.fallback).toBe(false);
    expect(r.replayed).toBe(true);
    expect(r.value.reason).toBe("awaiting_approval");
  });

  it("falls back to the readable error for anything without a recording", async () => {
    const live = retryTransient(alwaysLimited(), noWait);
    const r = await classifyReply(replayOnTransient(DEMO_FIXTURES, live), { ...input, thread: [{ from: "client", at: new Date(), body: "Who is this?" }] });
    expect(r.fallback).toBe(true);
    expect(r.error).toMatch(/RESOURCE_EXHAUSTED/);
  });
});

describe("provider failover and labels", () => {
  const down = (status: number, message = "provider error") => Object.assign(new Error(message), { statusCode: status });
  const primaryDown = (status = 429, message?: string) => labelProvider(new MockLanguageModelV4({ modelId: "gemini-x", doGenerate: async () => Promise.reject(down(status, message)) }), "google/gemini-x");
  const secondaryOk = () => new MockLanguageModelV4({ modelId: "gpt-x", doGenerate: textOf(good) });

  it("labels each answer with the provider that produced it", async () => {
    const live = labelProvider(new MockLanguageModelV4({ doGenerate: textOf(good) }), "openai/gpt-x");
    const r = await classifyReply(live, input);
    expect(r.provider).toBe("openai/gpt-x");
    expect(providerName("openai/gpt-x")).toBe("OpenAI gpt-x");
    expect(providerName("google/gemini-3.5-flash-lite")).toBe("Gemini gemini-3.5-flash-lite");
  });

  it.each([[429, "RESOURCE_EXHAUSTED quota"], [503, "high demand"], [500, "internal error"], [502, "bad gateway"]])("fails over to the secondary on a %s from the primary, and says so", async (status, message) => {
    const secondary = labelProvider(secondaryOk(), "openai/gpt-x");
    const r = await classifyReply(failover(primaryDown(status, message), secondary), input);
    expect(r.fallback).toBe(false);
    expect(r.provider).toBe("openai/gpt-x");
  });

  it("fails over when OpenAI reports a spent quota, and when the primary isn't configured", async () => {
    const secondary = labelProvider(secondaryOk(), "openai/gpt-x");
    expect((await classifyReply(failover(primaryDown(429, "You exceeded your current quota (insufficient_quota)"), secondary), input)).provider).toBe("openai/gpt-x");
    expect((await classifyReply(failover(unavailableModel("GOOGLE_GENERATIVE_AI_API_KEY is not set"), secondary), input)).provider).toBe("openai/gpt-x");
  });

  it("does not fail over for an error that isn't the provider's, like a bad request", async () => {
    const secondary = secondaryOk();
    const r = await classifyReply(failover(primaryDown(400, "invalid request"), labelProvider(secondary, "openai/gpt-x")), input);
    expect(r.fallback).toBe(true);
    expect(secondary.doGenerateCalls).toHaveLength(0);
  });

  it("uses the recorded response only after both providers fail", async () => {
    const both = failover(primaryDown(), retryTransient(labelProvider(new MockLanguageModelV4({ doGenerate: async () => Promise.reject(down(503, "high demand")) }), "openai/gpt-x"), async () => {}));
    const r = await classifyReply(replayOnTransient(DEMO_FIXTURES, both), { ...input, thread: [{ from: "client", at: new Date(), body: "Sorry, waiting on finance sign-off, should clear next week." }] });
    expect(r.replayed).toBe(true);
    expect(r.provider).toBeUndefined();
  });
});

describe("failover on a rejected key", () => {
  it("tries the secondary when the primary's key is rejected (401)", async () => {
    const rejected = labelProvider(new MockLanguageModelV4({ doGenerate: async () => Promise.reject(Object.assign(new Error("Incorrect API key"), { statusCode: 401 })) }), "openai/gpt-x");
    const secondary = labelProvider(new MockLanguageModelV4({ doGenerate: textOf(good) }), "google/gemini-x");
    const r = await classifyReply(failover(rejected, secondary), input);
    expect(r.provider).toBe("google/gemini-x");
  });
});
