import { beforeEach, describe, expect, it, vi } from "vitest";

// Sign-in with the demo credentials works on a database that was never seeded: the demo freelancer is created.
const h = vi.hoisted(() => ({ rows: [] as { id: string; email: string }[], created: 0, saved: 0 }));
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("iron-session", () => ({ getIronSession: async () => ({ save: async () => void h.saved++, destroy: () => {} }) }));
vi.mock("./db", () => ({ db: { freelancer: { findUnique: async ({ where }: { where: { email: string } }) => h.rows.find((r) => r.email === where.email) ?? null } } }));
vi.mock("./demo-seed", () => ({
  ensureDemoFreelancer: async () => {
    const row = { id: "f1", email: "demo@cleardue.app" };
    h.rows.push(row);
    h.created++;
    return row;
  },
}));

const { logIn } = await import("./auth");

beforeEach(() => {
  h.rows = [];
  h.created = 0;
  h.saved = 0;
  vi.stubEnv("DEMO_EMAIL", "demo@cleardue.app");
  vi.stubEnv("DEMO_PASSWORD", "judge-pass");
  vi.stubEnv("SESSION_PASSWORD", "x".repeat(32));
});

describe("logIn", () => {
  it("creates the demo freelancer on first sign-in with the right credentials", async () => {
    expect(await logIn(" Demo@ClearDue.app ", "judge-pass")).toBe(true);
    expect(h.created).toBe(1);
    expect(h.saved).toBe(1);
  });

  it("does not create anything for wrong credentials", async () => {
    expect(await logIn("demo@cleardue.app", "nope")).toBe(false);
    expect(await logIn("someone@else.test", "judge-pass")).toBe(false);
    expect(h.created).toBe(0);
  });

  it("uses the existing freelancer when there is one", async () => {
    h.rows.push({ id: "f0", email: "demo@cleardue.app" });
    expect(await logIn("demo@cleardue.app", "judge-pass")).toBe(true);
    expect(h.created).toBe(0);
  });
});
