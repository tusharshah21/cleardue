import { describe, expect, it } from "vitest";
import { clearProgress, markHandled, pageOfPath, pathForStep, readState, saveProgress, shouldOffer, STEPS, storageWorks, TOTAL, TOUR_KEY, wantsStart, wantsSuppress } from "./tour";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const throwing = () => ({
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
});

describe("offer once per browser", () => {
  it("offers on the first visit", () => {
    expect(shouldOffer(memory())).toBe(true);
  });

  it("never offers again after Start tour or Not now (both mark it handled)", () => {
    const s = memory();
    markHandled(s);
    expect(shouldOffer(s)).toBe(false);
    expect(readState(s).handled).toBe(true);
  });

  it("does not offer while a tour is half-way", () => {
    const s = memory();
    saveProgress(s, 3, { acme: "/invoices/abc" });
    expect(shouldOffer(s)).toBe(false);
  });

  it("is per browser: another browser's storage starts fresh", () => {
    const a = memory();
    markHandled(a);
    expect(shouldOffer(memory())).toBe(true);
  });
});

describe("replay and progress", () => {
  it("replays after the offer was handled: progress can be saved and cleared any time", () => {
    const s = memory();
    markHandled(s);
    saveProgress(s, 0);
    expect(readState(s).step).toBe(0);
    saveProgress(s, 4, { koala: "/pay/tok" });
    expect(readState(s)).toEqual({ handled: true, step: 4, links: { koala: "/pay/tok" } });
    clearProgress(s);
    expect(readState(s).step).toBeNull();
    expect(shouldOffer(s)).toBe(false);
  });

  it("keeps links between saves", () => {
    const s = memory();
    saveProgress(s, 2, { acme: "/invoices/a", koala: "/pay/k" });
    saveProgress(s, 3);
    expect(readState(s).links).toEqual({ acme: "/invoices/a", koala: "/pay/k" });
  });

  it("ignores a corrupt or out-of-range stored value", () => {
    const s = memory();
    s.setItem(TOUR_KEY, "{not json");
    expect(readState(s)).toEqual({ handled: false, step: null, links: {} });
    s.setItem(TOUR_KEY, JSON.stringify({ handled: true, step: 99 }));
    expect(readState(s).step).toBeNull();
  });
});

describe("storage failure", () => {
  it("never offers, never throws", () => {
    const s = throwing();
    expect(storageWorks(s)).toBe(false);
    expect(shouldOffer(s)).toBe(false);
    expect(() => {
      markHandled(s);
      saveProgress(s, 1);
      clearProgress(s);
    }).not.toThrow();
    expect(readState(s)).toEqual({ handled: false, step: null, links: {} });
  });

  it("treats missing storage like blocked storage", () => {
    expect(shouldOffer(undefined)).toBe(false);
    expect(shouldOffer(null)).toBe(false);
  });

  it("does not offer when reads work but writes are refused", () => {
    const s = { ...memory(), setItem: () => { throw new Error("quota"); } };
    expect(shouldOffer(s)).toBe(false);
  });
});

describe("?tour= parameter", () => {
  it("off suppresses, start starts, anything else does nothing", () => {
    expect(wantsSuppress("?tour=off")).toBe(true);
    expect(wantsSuppress("?x=1&tour=off")).toBe(true);
    expect(wantsSuppress("?tour=start")).toBe(false);
    expect(wantsStart("?tour=start")).toBe(true);
    expect(wantsStart("")).toBe(false);
  });
});

describe("steps", () => {
  it("has at most 9 steps with unique ids and texts", () => {
    expect(TOTAL).toBeLessThanOrEqual(9);
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(TOTAL);
    STEPS.forEach((s) => expect(s.text.length).toBeGreaterThan(10));
  });

  it("maps paths to pages and steps to paths", () => {
    expect(pageOfPath("/welcome")).toBe("welcome");
    expect(pageOfPath("/invoices/abc")).toBe("acme");
    expect(pageOfPath("/invoices/new")).toBeNull();
    expect(pageOfPath("/pay/tok")).toBe("pay");
    expect(pathForStep(0, {})).toBe("/welcome");
    expect(pathForStep(3, { acme: "/invoices/a" })).toBe("/invoices/a");
    expect(pathForStep(3, {})).toBeUndefined();
    expect(pathForStep(5, {})).toBe("/approvals");
    expect(pathForStep(6, { koala: "/pay/k" })).toBe("/pay/k");
    expect(pathForStep(7, {})).toBe("/analyst");
    expect(pathForStep(8, {})).toBe("/welcome");
  });
});
