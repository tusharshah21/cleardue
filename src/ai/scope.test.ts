import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { ACME_EXTRA, DEMO_FIXTURES } from "./demo-fixtures";
import { replayModel, unavailableModel } from "./replay";
import type { ScopeCheck } from "./schemas";
import { scopeCheck } from "./tasks";
import { gen } from "./test-utils";

const scope = `Acme Labs: Analytics dashboard redesign. Statement of work.
2. UI design: up to 8 screens for the analytics dashboard, desktop and tablet layouts.
3. Revisions: two rounds of revisions per screen. Further rounds are billed at USD 45/hour.
5. Out of scope: front-end development, copywriting, mobile app screens.`;
const says = (s: Partial<ScopeCheck>) =>
  new MockLanguageModelV4({
    doGenerate: gen([{ type: "text", text: JSON.stringify({ verdict: "IN_SCOPE", quotedClauses: [], reasoning: "r", estimatedHours: null, suggestedLineItem: null, ...s }) }]),
  });

describe("scopeCheck", () => {
  it("replays the demo verdict with verified clauses and a line item", async () => {
    const r = await scopeCheck(replayModel(DEMO_FIXTURES, unavailableModel("no key")), { scope, request: ACME_EXTRA });
    expect(r.value.verdict).toBe("OUT_OF_SCOPE");
    expect(r.value.quotedClauses).toHaveLength(2);
    expect(r.value.suggestedLineItem?.hours).toBe(32);
  });

  it("downgrades a verdict whose clauses aren't really in the scope to GRAY_ZONE", async () => {
    const r = await scopeCheck(says({ verdict: "IN_SCOPE", quotedClauses: ["Unlimited revisions included."] }), { scope, request: "A fifth round of revisions" });
    expect(r.value.verdict).toBe("GRAY_ZONE");
    expect(r.value.quotedClauses).toEqual([]);
  });

  it("keeps verified clauses", async () => {
    const clause = "Further rounds are billed at USD 45/hour.";
    const r = await scopeCheck(says({ verdict: "OUT_OF_SCOPE", quotedClauses: [clause] }), { scope, request: "A third round of revisions" });
    expect(r.value).toMatchObject({ verdict: "OUT_OF_SCOPE", quotedClauses: [clause] });
  });

  it("falls back to GRAY_ZONE readably when the AI is unavailable", async () => {
    const r = await scopeCheck(unavailableModel("ANTHROPIC_API_KEY is not set"), { scope, request: "x" });
    expect(r.fallback).toBe(true);
    expect(r.value).toMatchObject({ verdict: "GRAY_ZONE", suggestedLineItem: null });
  });
});
