import { describe, expect, it } from "vitest";
import { agLicence } from "./ag-licence";

// Shaped like an AG key: bracketed fields and underscores, the expiry as a base64 epoch in ms. Not a real key.
const keyExpiring = (iso: string) => `[TRIAL]_this_[v3]_[0102]_${Buffer.from(String(new Date(iso).getTime())).toString("base64")}_${"x".repeat(32)}`;

describe("AG Studio licence check", () => {
  it("is missing when unset or blank", () => {
    expect(agLicence(undefined)).toEqual({ state: "missing" });
    expect(agLicence("  ")).toEqual({ state: "missing" });
  });
  it("reads the expiry date from the key", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    expect(agLicence(keyExpiring("2026-12-19T00:00:00Z"), now)).toEqual({ state: "ok", expiry: "2026-12-19" });
    expect(agLicence(keyExpiring("2026-11-01T00:00:00Z"), now)).toEqual({ state: "expired", expiry: "2026-11-01" });
  });
  it("leaves a key without a readable date to Studio", () => {
    expect(agLicence("some-other-format")).toEqual({ state: "ok", expiry: null });
  });
});
