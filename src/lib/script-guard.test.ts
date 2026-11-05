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

import { hasPlaceholder, needsRewrite, templateMessage } from "./script-guard";

describe("placeholders", () => {
  it("flags the placeholders that reached an approval draft", () => {
    expect(hasPlaceholder("Please use the payment link: [Pay invoice 0159]\n\nBest,\n[Your name]")).toBe(true);
    expect(hasPlaceholder({ body: "See [link]" })).toBe(true);
    expect(needsRewrite("Hi [Your name]")).toBe(true);
  });

  it("allows ordinary brackets without a stand-in word group across lines", () => {
    expect(hasPlaceholder("Pay here: https://x.test/pay/abc (due 2026-11-05). Thanks, Aarav Mehta")).toBe(false);
    expect(hasPlaceholder("An array like [] or a lone [ bracket")).toBe(false);
  });

  it("the template signs with the real name and includes the real pay link", () => {
    const t = templateMessage({ freelancerName: "Aarav Mehta", payLink: "https://x.test/pay/abc", invoiceNumber: "0159" });
    expect(t).toContain("invoice 0159");
    expect(t).toContain("https://x.test/pay/abc");
    expect(t.endsWith("Aarav Mehta")).toBe(true);
    expect(hasPlaceholder(t)).toBe(false);
  });
});
