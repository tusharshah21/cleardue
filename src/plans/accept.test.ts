import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MANDATE } from "@/agent/mandate";

// In-memory stand-ins for the database and PayPal: just enough for acceptPlan and approveProposal.
const h = vi.hoisted(() => ({ store: { autopilot: false, proposals: [] as Record<string, unknown>[], planGroups: [] as Record<string, unknown>[] } }));
const NOW = new Date("2026-11-02T12:00:00Z"); // midday in London

const invoice = () => ({
  id: "inv1",
  clientId: "c1",
  projectId: "p1",
  paypalInvoiceId: "INV2-ORIG",
  payToken: "tok",
  status: "SENT",
  currency: "GBP",
  invoiceNumber: "0002",
  totalMinor: 180000,
  paidMinor: 0,
  dueDate: new Date("2026-10-28T00:00:00Z"),
  items: [{ name: "Webflow build", quantity: 1, unitAmountMinor: 180000, unit: "AMOUNT" }],
  messages: [],
  client: {
    id: "c1",
    name: "Brightside Studio",
    email: "sam@brightside.test",
    approverEmail: null,
    timezone: "Europe/London",
    mandate: { autopilot: h.store.autopilot },
    freelancer: { id: "f1", name: "Aarav Mehta", businessName: "Aarav Mehta Design", country: "IN", mandate: DEFAULT_MANDATE },
  },
});
const kase = { id: "case1", invoiceId: "inv1", reason: "cash_constraint", state: "open", confidence: 0.95, actions: [] };

vi.mock("@/lib/db", () => {
  const { store } = h;
  return {
    db: {
      invoice: {
        findUnique: async () => invoice(),
        findFirst: async () => invoice(),
        create: async () => ({}),
        update: async () => ({}),
      },
      case: { findUnique: async () => kase, upsert: async () => kase, update: async () => kase },
      payerQuestion: { count: async () => 0 },
      proposedAction: {
        findFirst: async ({ where }: { where: { id?: string; status?: string } }) =>
          store.proposals.find((p) => (where.id ? p.id === where.id : true) && p.status === (where.status ?? p.status)) ?? null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `pa${store.proposals.length + 1}`, status: "pending", ...data, case: kase };
          store.proposals.push(row);
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(store.proposals.find((p) => p.id === where.id)!, data),
      },
      planGroup: {
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const g = { id: "g1", ...data };
          store.planGroups.push(g);
          return g;
        },
        update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(store.planGroups[0], data),
      },
      timelineEvent: { create: async () => ({}) },
    },
  };
});
vi.mock("@/lib/invoicing", () => ({ newPayToken: () => "new-token", syncInvoice: async () => undefined }));
vi.mock("@/paypal/invoices", () => {
  let n = 0;
  return {
    getInvoice: vi.fn(async (id: string) => ({ id, status: "SENT", detail: { currency_code: "GBP" } })),
    createDraftInvoice: vi.fn(async () => ({ id: `INV2-NEW-${++n}`, status: "DRAFT" })),
    sendInvoice: vi.fn(async (id: string) => ({ payerViewUrl: `https://pay/${id}` })),
    cancelInvoice: vi.fn(async () => undefined),
    deleteDraftInvoice: vi.fn(async () => undefined),
  };
});

const paypal = await import("@/paypal/invoices");
const { acceptPlan } = await import("./accept");
const { approveProposal } = await import("@/agent/cases");

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.clearAllMocks();
  h.store.proposals = [];
  h.store.planGroups = [];
});

describe("acceptPlan follows the mandate", () => {
  it("autopilot on: the client's acceptance runs the plan pipeline immediately", async () => {
    h.store.autopilot = true;
    const r = await acceptPlan("tok", 0, NOW);
    expect(r.state).toBe("active");
    expect(paypal.createDraftInvoice).toHaveBeenCalledTimes(2);
    expect(paypal.cancelInvoice).toHaveBeenCalledWith("INV2-ORIG", expect.objectContaining({ sendToRecipient: false }));
    expect(h.store.proposals).toEqual([]);
  });

  it("autopilot off: acceptance queues a needs_approval proposal, and approving it runs the pipeline", async () => {
    h.store.autopilot = false;
    const r = await acceptPlan("tok", 0, NOW);
    expect(r.state).toBe("awaiting_approval");
    expect(paypal.createDraftInvoice).not.toHaveBeenCalled();
    expect(h.store.proposals).toHaveLength(1);
    const p = h.store.proposals[0];
    expect(p).toMatchObject({ type: "apply_payment_plan", mandateVerdict: "needs_approval", mandateReasons: ["autopilot is off for this client"] });
    expect(p.params).toEqual({ instalments: [{ amount: "900.00", due_date: "2026-11-02" }, { amount: "900.00", due_date: "2026-12-02" }] });

    // A second acceptance while waiting is refused.
    await expect(acceptPlan("tok", 1, NOW)).rejects.toThrow(/already confirming/);

    await approveProposal(p.id as string, "f1");
    expect(p.status).toBe("executed");
    expect(paypal.createDraftInvoice).toHaveBeenCalledTimes(2);
    expect(paypal.cancelInvoice).toHaveBeenCalledOnce();
    expect(h.store.planGroups[0]).toMatchObject({ state: "active" });
  });
});
