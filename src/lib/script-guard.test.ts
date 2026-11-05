import { describe, expect, it } from "vitest";
import { hasForeignScript } from "./script-guard";

describe("hasForeignScript", () => {
  it("flags the exact note that reached a timeline", () => {
    expect(hasForeignScript("I предложed a two-part payment plan and sent the client a matching message.")).toBe(true);
  });

  it("flags other scripts inside nested values", () => {
    expect(hasForeignScript({ body: "Hello", list: ["fine", "pay σήμερα"] })).toBe(true);
    expect(hasForeignScript(["请尽快付款"])).toBe(true);
  });

  it("allows plain English, accented Latin, currency, dates and typographic punctuation", () => {
    expect(hasForeignScript("I proposed a two-part plan: £900 on 2026-11-06 and €50 on 5 December. Café Zoë’s “quote”.")).toBe(false);
    expect(hasForeignScript({ n: 3, ok: true, none: null, arr: ["a", "b"] })).toBe(false);
  });
});
