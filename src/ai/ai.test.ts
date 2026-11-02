import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { DEMO_FIXTURES } from "./demo-fixtures";
import { TASK_TAG as CLASSIFY } from "./prompts/classify-reply";
import { findFixture, replayModel, unavailableModel } from "./replay";
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
  it("returns a validated classification", async () => {
    const r = await classifyReply(new MockLanguageModelV4({ doGenerate: textOf(good) }), input);
    expect(r).toEqual({ value: good, fallback: false });
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
