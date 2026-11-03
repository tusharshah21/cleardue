import { beforeEach, describe, expect, it, vi } from "vitest";

// Just enough database and PayPal for a reset: one existing demo freelancer with one open and one paid invoice.
const h = vi.hoisted(() => ({ calls: [] as string[], oldest: null as Date | null }));

vi.mock("@/lib/db", () => {
  const row = (data: Record<string, unknown>) => ({ id: `id${h.calls.length}`, ...data });
  return {
    db: {
      freelancer: {
        findUnique: async () => ({ id: "f1", email: "demo@cleardue.app" }),
        update: async ({ data }: { data: Record<string, unknown> }) => ({ id: "f1", ...data }),
        create: async () => h.calls.push("freelancer.create"),
      },
      invoice: {
        // The status filter is the database's job; the reset must ask only for open invoices that exist in PayPal.
        findMany: async ({ where }: { where: { status: { in: string[] } } }) =>
          [{ paypalInvoiceId: "INV2-OPEN", status: "SENT" }, { paypalInvoiceId: "INV2-PAID", status: "PAID" }].filter((i) => where.status.in.includes(i.status)),
        create: async ({ data }: { data: Record<string, unknown> }) => row(data),
      },
      client: {
        deleteMany: async ({ where }: { where: { freelancerId: string } }) => h.calls.push(`client.deleteMany:${where.freelancerId}`),
        create: async ({ data }: { data: Record<string, unknown> }) => row(data),
        findFirst: async () => (h.oldest ? { createdAt: h.oldest } : null),
      },
      project: { create: async ({ data }: { data: Record<string, unknown> }) => row(data) },
      message: { create: async () => ({}) },
    },
  };
});
vi.mock("@/paypal/invoices", () => ({
  cancelInvoice: async (id: string) => h.calls.push(`cancel:${id}`),
  deleteDraftInvoice: async (id: string) => h.calls.push(`delete:${id}`),
}));
vi.mock("@/lib/invoicing", () => ({
  createAndSendInvoice: async ({ client }: { client: { name: string } }) => (h.calls.push(`send:${client.name}`), { id: "i", paypalInvoiceId: "INV2-NEW", status: "SENT" }),
  lineTotal: () => 0,
  newPayToken: () => "tok",
}));

const { dailyDemoReset, manualResetWait, nextScheduledReset, resetDemo } = await import("./demo-seed");

beforeEach(() => {
  h.calls = [];
  h.oldest = null;
  vi.unstubAllEnvs();
});

describe("resetDemo", () => {
  it("cancels the old open PayPal invoices, then replaces only the demo freelancer's clients", async () => {
    const result = await resetDemo({ withPayPal: true });
    expect(h.calls).toEqual(["cancel:INV2-OPEN", "client.deleteMany:f1", "send:Acme Labs", "send:Brightside Studio", "send:Koala Digital"]);
    expect(result).toMatchObject({ freelancerId: "f1", closed: 1 });
  });
});

describe("dailyDemoReset", () => {
  const now = new Date("2026-11-03T12:00:00Z");

  it("does nothing unless DEMO_DAILY_RESET=true", async () => {
    expect(await dailyDemoReset(now)).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("resets once the 03:00 UTC slot has passed since the last reset", async () => {
    vi.stubEnv("DEMO_DAILY_RESET", "true");
    vi.stubEnv("PAYPAL_MODE", "mock");
    h.oldest = new Date("2026-11-03T03:00:00Z"); // already reset in today's slot
    expect(await dailyDemoReset(now)).toBe(false);
    h.oldest = new Date("2026-11-03T02:59:00Z"); // a manual reset just before the slot doesn't count
    expect(await dailyDemoReset(now)).toBe(true);
    expect(h.calls).toContain("cancel:INV2-OPEN");
  });

  it("waits for 03:00 UTC: at 02:00 yesterday's slot still stands", async () => {
    vi.stubEnv("DEMO_DAILY_RESET", "true");
    h.oldest = new Date("2026-11-02T03:00:00Z");
    expect(await dailyDemoReset(new Date("2026-11-03T02:00:00Z"))).toBe(false);
  });

  it("names the next slot", () => {
    expect(nextScheduledReset(new Date("2026-11-03T02:00:00Z")).toISOString()).toBe("2026-11-03T03:00:00.000Z");
    expect(nextScheduledReset(now).toISOString()).toBe("2026-11-04T03:00:00.000Z");
  });
});

describe("manualResetWait", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  it("allows one reset per 5 minutes", async () => {
    expect(await manualResetWait(now)).toBe(0); // no demo data yet
    h.oldest = new Date("2026-11-03T11:58:30Z");
    expect(await manualResetWait(now)).toBe(4);
    h.oldest = new Date("2026-11-03T11:55:00Z");
    expect(await manualResetWait(now)).toBe(0);
  });
});
