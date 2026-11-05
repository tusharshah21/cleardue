import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoices: [] as Record<string, unknown>[],
  proposals: [] as { id: string; status: string; type: string; params: unknown; result?: unknown }[],
  timeline: [] as string[],
}));
vi.mock("@/lib/db", () => ({
  db: {
    invoice: { findMany: async () => h.invoices },
    proposedAction: {
      findMany: async () => h.proposals.filter((p) => p.status === "pending"),
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: { status: string; result: unknown } }) => {
        h.proposals.filter((p) => where.id.in.includes(p.id)).forEach((p) => Object.assign(p, data));
        return { count: where.id.in.length };
      },
    },
    timelineEvent: { create: async ({ data }: { data: { summary: string } }) => void h.timeline.push(data.summary) },
  },
}));

const { receivablesFor } = await import("./analyst");
const { supersedePending } = await import("./supersede");

const client = { id: "c1", name: "Brightside Studio" };
const inv = (id: string, over: Record<string, unknown>) => ({ id, client, planGroupId: null, planGroup: null, case: null, invoiceNumber: id, currency: "GBP", paidMinor: 0, totalMinor: 90000, status: "SENT", dueDate: new Date("2026-11-05T00:00:00Z"), ...over });
const NOW = new Date("2026-11-06T12:00:00Z");

describe("receivablesFor with an accepted plan", () => {
  it("lists the unpaid parts as plan parts of the cancelled original, so the total matches the dashboard", async () => {
    const group = { id: "g1", originalInvoiceId: "0070" };
    h.invoices = [
      inv("0070", { status: "CANCELLED", totalMinor: 180000 }),
      inv("p1", { planGroupId: "g1", planGroup: group, invoiceNumber: "0071", dueDate: new Date("2026-11-05T00:00:00Z") }),
      inv("p2", { planGroupId: "g1", planGroup: group, invoiceNumber: "0072", dueDate: new Date("2026-12-05T00:00:00Z") }),
      inv("0069", { client: { id: "c2", name: "Acme Labs" }, currency: "USD", totalMinor: 240000, dueDate: new Date("2026-10-27T00:00:00Z") }),
    ];
    const rows = await receivablesFor("f1", NOW);
    expect(rows.map((r) => [r.client, r.invoice, r.outstanding])).toEqual([
      ["Acme Labs", "0069", 2400],
      ["Brightside Studio", "Part 1 of 2, payment plan for invoice 0070", 900],
      ["Brightside Studio", "Part 2 of 2, payment plan for invoice 0070", 900],
    ]);
    expect(rows[1].planPartOf).toBe("0070");
    // £900 + £900 owed by Brightside, as the dashboard's "Total owed" counts it; the cancelled original adds nothing
    expect(rows.filter((r) => r.currency === "GBP").reduce((n, r) => n + r.outstanding, 0)).toBe(1800);
  });

  it("drops a part once it is paid", async () => {
    const group = { id: "g1", originalInvoiceId: "0070" };
    h.invoices = [inv("p1", { planGroupId: "g1", planGroup: group, status: "PAID" }), inv("p2", { planGroupId: "g1", planGroup: group, dueDate: new Date("2026-12-05T00:00:00Z") })];
    expect((await receivablesFor("f1", NOW)).map((r) => r.invoice)).toEqual(["Part 2 of 2, payment plan for invoice ?"]);
  });
});

describe("supersedePending", () => {
  it("marks pending proposals Superseded (never Rejected) and says so on the timeline", async () => {
    h.proposals = [{ id: "a1", status: "pending", type: "send_message", params: { to: "client", tone: "friendly", subject: "s", body: "b" } }, { id: "a2", status: "executed", type: "pause_reminders", params: {} }];
    h.timeline = [];
    expect(await supersedePending("case1", "inv1", "the invoice is now cancelled")).toBe(1);
    expect(h.proposals.map((p) => p.status)).toEqual(["superseded", "executed"]);
    expect(h.timeline).toHaveLength(1);
    expect(h.timeline[0]).toMatch(/^Superseded: .*\(the invoice is now cancelled\)$/);
    expect(h.timeline[0]).not.toMatch(/ejected/);
  });
});
