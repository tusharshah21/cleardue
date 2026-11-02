import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REASONS } from "@/ai/schemas";
import { EVAL_SETS, score, type EvalCase } from "./score";

const load = (set: string) => JSON.parse(readFileSync(new URL(`./${set}.json`, import.meta.url), "utf8")) as { today: string; cases: EvalCase[] };

describe("eval sets", () => {
  it.each(EVAL_SETS)("%s: unique ids, known reasons, ISO dates", (set) => {
    const { today, cases } = load(set);
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      expect(REASONS, c.id).toContain(c.expected);
      expect(c.messages.length, c.id).toBeGreaterThan(0);
      if (c.promisedDate) expect(c.promisedDate, c.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("synthetic has 25 to 30 cases covering every reason at least 3 times", () => {
    const { cases } = load("synthetic");
    expect(cases.length).toBeGreaterThanOrEqual(25);
    expect(cases.length).toBeLessThanOrEqual(30);
    for (const reason of REASONS) expect(cases.filter((c) => c.expected === reason).length, reason).toBeGreaterThanOrEqual(3);
  });
});

describe("score", () => {
  it("counts per-reason accuracy, dates and misses", () => {
    const s = score([
      { id: "a", expected: "forgot", got: "forgot", confidence: 0.9, fallback: false, gotDate: null },
      { id: "b", expected: "forgot", got: "other", confidence: 0.4, fallback: false, gotDate: null },
      { id: "c", expected: "promised_date", got: "promised_date", confidence: 0.9, fallback: false, promisedDate: "2026-11-06", gotDate: "2026-11-06" },
      { id: "d", expected: "promised_date", got: "promised_date", confidence: 0.9, fallback: true, promisedDate: "2026-11-30", gotDate: "2026-11-29" },
    ]);
    expect(s).toMatchObject({ total: 4, correct: 3, fallbacks: 1, dates: { n: 2, correct: 1 } });
    expect(s.perReason).toEqual([
      { reason: "forgot", n: 2, correct: 1 },
      { reason: "promised_date", n: 2, correct: 2 },
    ]);
    expect(s.misses.map((m) => m.id)).toEqual(["b"]);
  });
});
