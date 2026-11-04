import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MANDATE } from "./mandate";

// The analyst's one write path: mandate-checked, but never auto-executed. In-memory db, real mandate and gate context.
const h = vi.hoisted(() => ({ autopilot: true, tone: "firm", rows: [] as Record<string, unknown>[], timeline: [] as string[] }));
// 2026-11-10 15:00 UTC is 10:00 in New York: outside quiet hours, so an autopilot client's friendly message would auto-run.
const NOW = new Date("2026-11-10T15:00:00Z");

const invoice = (id: string, name: string) => ({
  id,
  clientId: `c-${id}`,
  paypalInvoiceId: `INV2-${id}`,
  invoiceNumber: id === "a" ? "0001" : "0002",
  status: "SENT",
  currency: "USD",
  totalMinor: 240000,
  paidMinor: 0,
  dueDate: new Date("2026-11-01T00:00:00Z"),
  messages: [],
  client: {
    id: `c-${id}`,
    name,
    email: `${id}@client.test`,
    approverEmail: null,
    timezone: "America/New_York",
    mandate: { autopilot: h.autopilot, toneCeiling: h.tone },
    freelancer: { id: "f1", name: "Aarav Mehta", mandate: DEFAULT_MANDATE },
  },
});
const all = () => [invoice("a", "Acme Labs"), invoice("b", "Acme Studio"), invoice("c", "Koala Digital")];

vi.mock("@/lib/db", () => ({
  db: {
    invoice: { findMany: async () => all() },
    case: { upsert: async ({ where }: { where: { invoiceId: string } }) => ({ id: `case-${where.invoiceId}`, invoiceId: where.invoiceId, state: "open", confidence: null }) },
    proposedAction: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `pa${h.rows.length + 1}`, ...data };
        h.rows.push(row);
        return row;
      },
    },
    timelineEvent: { create: async ({ data }: { data: { summary: string } }) => void h.timeline.push(data.summary) },
  },
}));
vi.mock("./cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cases")>()),
  loadInvoice: async (id: string) => all().find((i) => i.id === id),
}));

const { proposeFromAnalyst } = await import("./analyst");
const nudge = { to: "client", tone: "friendly", subject: "Quick nudge", body: "Hi, a friendly reminder about the invoice. Thanks!" };

beforeEach(() => {
  h.autopilot = true;
  h.tone = "firm";
  h.rows = [];
  h.timeline = [];
});

describe("proposeFromAnalyst", () => {
  it("never auto-runs: a message the mandate would allow on its own is queued for approval", async () => {
    const r = await proposeFromAnalyst("f1", { invoice: "Koala", tool: "send_message", input: nudge }, NOW);
    expect(r.status).toBe("queued_for_freelancer_approval");
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ type: "send_message", status: "pending", mandateVerdict: "needs_approval" });
    expect((h.rows[0].mandateReasons as string[]).join(" ")).toContain("analyst");
    expect(h.timeline[0]).toContain("collections analyst");
  });

  it("keeps a mandate denial a denial: a tone above the ceiling is recorded as denied, not queued", async () => {
    h.tone = "friendly";
    const r = await proposeFromAnalyst("f1", { invoice: "Koala", tool: "send_message", input: { ...nudge, tone: "formal" } }, NOW);
    expect(r.status).toBe("denied");
    expect(h.rows[0]).toMatchObject({ status: "denied", mandateVerdict: "deny" });
  });

  it("rejects a plan whose instalments don't add up, through the same mandate checks", async () => {
    const r = await proposeFromAnalyst("f1", { invoice: "Koala", tool: "offer_payment_plan", input: { instalments: [{ amount: "100.00", due_date: "2026-11-12" }, { amount: "100.00", due_date: "2026-12-10" }], tone: "friendly", message: "Here is a plan." } }, NOW);
    expect(r.status).toBe("denied");
  });

  it("asks for the invoice id when a name matches more than one open invoice, and records nothing", async () => {
    const r = await proposeFromAnalyst("f1", { invoice: "Acme", tool: "send_message", input: nudge }, NOW);
    expect(r).toMatchObject({ status: "error" });
    expect(h.rows).toHaveLength(0);
  });

  it("finds nothing for an unknown client", async () => {
    const r = await proposeFromAnalyst("f1", { invoice: "Nobody", tool: "send_message", input: nudge }, NOW);
    expect(r).toMatchObject({ status: "error" });
    expect(h.rows).toHaveLength(0);
  });
});
