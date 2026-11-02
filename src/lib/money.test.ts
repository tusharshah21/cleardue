import { describe, expect, it } from "vitest";
import { fromMinor, toMinor } from "./money";

describe("money", () => {
  it("round-trips two-decimal currencies", () => {
    expect(toMinor("123.45", "USD")).toBe(12345);
    expect(toMinor("0.5", "GBP")).toBe(50);
    expect(toMinor("10", "AUD")).toBe(1000);
    expect(toMinor("10.50", "USD")).toBe(1050);
    expect(fromMinor(12345, "USD")).toBe("123.45");
    expect(fromMinor(5, "USD")).toBe("0.05");
    expect(fromMinor(0, "USD")).toBe("0.00");
  });

  it("handles zero-decimal currencies", () => {
    expect(toMinor("1500", "JPY")).toBe(1500);
    expect(fromMinor(1500, "JPY")).toBe("1500");
    expect(() => toMinor("15.5", "JPY")).toThrow();
  });

  it("rejects malformed amounts", () => {
    expect(() => toMinor("1.234", "USD")).toThrow();
    expect(() => toMinor("-1", "USD")).toThrow();
    expect(() => toMinor("abc", "USD")).toThrow();
    expect(() => fromMinor(1.5, "USD")).toThrow();
    expect(() => fromMinor(-1, "USD")).toThrow();
  });
});
