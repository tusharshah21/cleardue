import { describe, expect, it } from "vitest";
import { ago } from "./app-state";

describe("ago", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  it("says never for a job that hasn't run", () => {
    expect(ago(null, now)).toBe("never");
  });
  it("reads minutes, hours and days", () => {
    expect(ago(new Date("2026-11-05T11:59:40Z"), now)).toBe("just now");
    expect(ago(new Date("2026-11-05T11:55:00Z"), now)).toBe("5 min ago");
    expect(ago(new Date("2026-11-05T09:00:00Z"), now)).toBe("3 h ago");
    expect(ago(new Date("2026-11-01T12:00:00Z"), now)).toBe("4 days ago");
  });
});
