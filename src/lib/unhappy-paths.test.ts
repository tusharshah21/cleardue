// Things that change on PayPal's side, outside ClearDue: refunds, cancellations, payments made elsewhere, plan parts
// cancelled. Driven by PayPal's own sample webhook payloads (src/paypal/fixtures, recorded from the sandbox's
// simulate-event) against an in-memory stand-in for the database. PayPal stays the source of truth: the test's
// getInvoice answer is what the invoice becomes.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };
const h = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, paypal: new Map<string, { status: string; paid?: string }>(), seq: 0, getFails: false, holdReason: null as string | null }));

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === "OR") return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    const v = row[k];
    if (cond === null || typeof cond !== "object" || cond instanceof Date) return (v instanceof Date ? v.getTime() : v) === (cond instanceof Date ? cond.getTime() : cond);
    const c = cond as Record<string, unknown>;
    const t = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
    if ("in" in c && !(c.in as unknown[]).includes(v)) return false;
    if ("notIn" in c && (c.notIn as unknown[]).includes(v)) return false;
    if ("not" in c && (c.not === null ? v == null : v === c.not)) return false;
    if ("lt" in c && !(v != null && t(v) < t(c.lt))) return false;
    if ("lte" in c && !(v != null && t(v) <= t(c.lte))) return false;
    if ("gt" in c && !(v != null && t(v) > t(c.gt))) return false;
    return true;
  });
}
const copy = (r: Row | undefined) => (r ? { ...r } : null);
function table(name: string) {
  const rows = () => (h.tables[name] ??= []);
  const withIncludes = (r: Row | undefined, include?: Record<string, unknown>) =>
    r && include?.invoices ? { ...r, invoices: (h.tables.invoice ?? []).filter((i) => i.planGroupId === r.id).sort((a, b) => (a.dueDate as Date).getTime() - (b.dueDate as Date).getTime()) } : r;
  return {
    // Copies out, like Prisma: callers compare the row they read with the one an update returns.
    findUnique: async ({ where, include }: { where: Record<string, unknown>; include?: Record<string, unknown> }) => copy(withIncludes(rows().find((r) => matches(r, where)), include)),
    findFirst: async ({ where }: { where: Record<string, unknown> }) => copy(rows().find((r) => matches(r, where))),
    findMany: async ({ where, take }: { where?: Record<string, unknown>; take?: number } = {}) => rows().filter((r) => matches(r, where)).slice(0, take ?? Infinity).map((r) => ({ ...r })),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `${name}-${++h.seq}`, createdAt: new Date(), ...data } as Row;
      rows().push(row);
      return row;
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = rows().find((r) => matches(r, where));
      if (!row) throw new Error(`${name} not found`);
      return { ...Object.assign(row, data, { updatedAt: new Date() }) };
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows().filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
    upsert: async ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const row = rows().find((r) => matches(r, where));
      if (row) return Object.assign(row, update);
      const fresh = { processed: false, receivedAt: new Date(), ...create } as unknown as Row;
      rows().push(fresh);
      return fresh;
    },
  };
}
vi.mock("@/lib/db", () => ({
  db: new Proxy({}, { get: (_, name: string) => table(name) }),
}));
vi.mock("@/paypal/invoices", async (orig) => ({
  ...(await orig<typeof import("@/paypal/invoices")>()),
  heldPaymentReason: async () => h.holdReason,
  getInvoice: async (id: string) => {
    if (h.getFails) throw new Error("PayPal did not respond within 15s");
    const p = h.paypal.get(id)!;
    return { id, status: p.status, detail: { currency_code: "USD" }, amount: { currency_code: "USD", value: "500.00" }, ...(p.paid && { payments: { paid_amount: { currency_code: "USD", value: p.paid } } }) };
  },
}));
const afterQueue: Promise<unknown>[] = [];
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => void afterQueue.push(fn()) }));
const verify = vi.hoisted(() => vi.fn());
vi.mock("@/paypal/webhooks", async (orig) => ({ ...(await orig<typeof import("@/paypal/webhooks")>()), verifyWebhookSignature: verify }));

import { handleWebhookEvent, syncStale } from "./invoicing";
import { POST } from "@/app/api/webhooks/paypal/route";

// Each recorded sample names a different made-up invoice; point them all at the one the test seeds.
const PP_ID = "INV2-5U8W-GKP5-C8M5-M58R";
function fixture(type: string) {
  const event = JSON.parse(readFileSync(`src/paypal/fixtures/invoicing-invoice-${type}.json`, "utf8"));
  event.resource.id = PP_ID;
  return event;
}
const rows = (t: string) => h.tables[t] ?? [];
const timeline = () => rows("timelineEvent").map((e) => e.summary as string);
const old = new Date(Date.now() - 3600_000);

function seed(status: string, opts: { paid?: number; pending?: string[]; caseState?: string; planGroupId?: string; paypalId?: string } = {}) {
  const inv = { id: `inv-${++h.seq}`, paypalInvoiceId: opts.paypalId ?? PP_ID, status, currency: "USD", totalMinor: 50_000, paidMinor: opts.paid ?? 0, dueDate: new Date(), createdAt: new Date(), lastSyncedAt: old, planGroupId: opts.planGroupId ?? null, invoiceNumber: null };
  rows("invoice").push(inv);
  const kase = { id: `case-${h.seq}`, invoiceId: inv.id, state: opts.caseState ?? "open", pausedUntil: null };
  (h.tables.case ??= []).push(kase);
  for (const type of opts.pending ?? []) (h.tables.proposedAction ??= []).push({ id: `p-${++h.seq}`, caseId: kase.id, type, status: "pending", params: { note: "x", tone: "friendly" } });
  return { inv, kase };
}
const deliver = (type: string) => handleWebhookEvent(fixture(type), { verified: true, process: true, note: null, source: "webhook" });
const request = (body: unknown) => new Request("http://x/api/webhooks/paypal", { method: "POST", body: JSON.stringify(body), headers: { "paypal-transmission-id": "t", "paypal-transmission-sig": "s" } });

beforeEach(() => {
  h.tables = { invoice: [] };
  h.paypal.clear();
  h.getFails = false;
  h.holdReason = null;
  afterQueue.length = 0;
  verify.mockReset().mockResolvedValue({ verified: true });
});

describe("(a) refunded in PayPal", () => {
  it("webhook: a paid invoice becomes REFUNDED and the timeline says the agent is paused", async () => {
    seed("PAID", { paid: 50_000, caseState: "resolved" });
    h.paypal.set(PP_ID, { status: "REFUNDED", paid: "500.00" });
    expect(await deliver("refunded")).toBe(true);
    expect(rows("invoice")[0].status).toBe("REFUNDED");
    expect(timeline()).toContain("Refunded in PayPal, agent paused. No more reminders, plans or messages on this invoice.");
  });

  it("webhook: a partial refund supersedes the agent's pending proposals", async () => {
    const { kase } = seed("PARTIALLY_PAID", { paid: 20_000, pending: ["send_invoice_reminder", "offer_payment_plan"] });
    h.paypal.set(PP_ID, { status: "PARTIALLY_REFUNDED", paid: "200.00" });
    await deliver("refunded");
    expect(rows("proposedAction").map((p) => p.status)).toEqual(["superseded", "superseded"]);
    expect(rows("case").find((c) => c.id === kase.id)?.state).toBe("resolved");
    expect(timeline().some((s) => s.startsWith("Partly refunded in PayPal, agent paused"))).toBe(true);
  });

  it("polling fallback: /api/sync re-reads recently paid invoices, so a refund is caught with no webhook at all", async () => {
    seed("PAID", { paid: 50_000, caseState: "resolved" });
    h.paypal.set(PP_ID, { status: "REFUNDED", paid: "500.00" });
    const r = await syncStale();
    expect(r.synced).toBe(1);
    expect(rows("invoice")[0].status).toBe("REFUNDED");
    expect(timeline().some((s) => s.startsWith("Refunded in PayPal"))).toBe(true);
  });
});

describe("(b) cancelled from the PayPal dashboard", () => {
  it("supersedes pending reminders and plans, closes the case, and says so", async () => {
    seed("SENT", { pending: ["send_invoice_reminder", "pause_reminders", "offer_payment_plan"] });
    h.paypal.set(PP_ID, { status: "CANCELLED" });
    await deliver("cancelled");
    expect(rows("proposedAction").every((p) => p.status === "superseded")).toBe(true);
    expect(rows("case")[0].state).toBe("resolved");
    expect(timeline()).toContain("Cancelled in PayPal, agent stopped. It will not remind, reschedule or split this invoice.");
  });
});

describe("(c) paid outside ClearDue", () => {
  it("marks it paid, supersedes the reminder that was waiting for approval, and says where it was paid", async () => {
    seed("SENT", { pending: ["send_invoice_reminder"] });
    h.paypal.set(PP_ID, { status: "PAID", paid: "500.00" });
    await deliver("paid");
    expect(rows("invoice")[0]).toMatchObject({ status: "PAID", paidMinor: 50_000 });
    expect(rows("proposedAction")[0].status).toBe("superseded");
    expect(timeline()).toContain("Paid in PayPal outside ClearDue, reminders stopped.");
  });
});

describe("(d) a split-plan part cancelled or refunded", () => {
  it("marks the parent plan interrupted and tells the freelancer on the original invoice", async () => {
    const original = seed("CANCELLED", { paypalId: "INV2-ORIGINAL", caseState: "resolved" });
    (h.tables.planGroup ??= []).push({ id: "g1", originalInvoiceId: original.inv.id, state: "active", error: null });
    seed("PAID", { planGroupId: "g1", paypalId: "INV2-PART-1", paid: 25_000 });
    rows("invoice")[1].dueDate = new Date(Date.now() - 86_400_000);
    seed("SENT", { planGroupId: "g1" }); // part 2, the recorded sample's invoice id
    h.paypal.set(PP_ID, { status: "CANCELLED" });
    await deliver("cancelled");
    expect(rows("planGroup")[0]).toMatchObject({ state: "interrupted", error: "Part 2 of 2 was cancelled in PayPal" });
    const onOriginal = rows("timelineEvent").filter((e) => e.invoiceId === original.inv.id).map((e) => e.summary);
    expect(onOriginal[0]).toMatch(/^Part 2 of 2 was cancelled in PayPal\. The payment plan is interrupted/);
  });
});

describe("webhook route", () => {
  it("acknowledges first, ignores duplicates (PayPal retries), and processes once", async () => {
    seed("SENT");
    h.paypal.set(PP_ID, { status: "PAID", paid: "500.00" });
    const ev = fixture("paid");
    expect((await POST(request(ev))).status).toBe(200);
    await Promise.all(afterQueue);
    expect(rows("webhookEvent")[0]).toMatchObject({ id: ev.id, processed: true, verified: true });
    const again = await POST(request(ev));
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(timeline().filter((s) => s.startsWith("Paid in PayPal"))).toHaveLength(1);
  });

  it("verifies the signature before anything else and rejects a bad one with 400", async () => {
    verify.mockResolvedValue({ verified: false, reason: "verification_status FAILURE" });
    const res = await POST(request(fixture("paid")));
    expect(res.status).toBe(400);
    expect(rows("webhookEvent")[0]).toMatchObject({ verified: false, processed: false });
  });

  it("accepts unknown event types with a 2xx and a log line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await POST(request({ id: "WH-NEW-1", event_type: "PAYMENT.SALE.COMPLETED", resource: { surprise: true } }));
    await Promise.all(afterQueue);
    expect(res.status).toBe(200);
    expect(log.mock.calls.flat().join(" ")).toMatch(/ignoring event type PAYMENT\.SALE\.COMPLETED/);
    log.mockRestore();
  });

  it("never 500s on payloads it doesn't recognise", async () => {
    for (const body of [{ id: "WH-2", event_type: "INVOICING.INVOICE.PAID" }, { id: "WH-3", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-NOT-OURS" } } }]) {
      expect((await POST(request(body))).status).toBe(200);
    }
    expect((await POST(new Request("http://x", { method: "POST", body: "not json" }))).status).toBe(400);
    expect((await POST(request({ hello: "world" }))).status).toBe(400);
  });

  it("a sync that fails after the ack is left unprocessed, and polling retries it", async () => {
    seed("SENT");
    h.paypal.set(PP_ID, { status: "CANCELLED" });
    h.getFails = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await POST(request(fixture("cancelled")))).status).toBe(200);
    await Promise.all(afterQueue);
    expect(rows("webhookEvent")[0].processed).toBe(false);
    h.getFails = false;
    rows("invoice")[0].lastSyncedAt = new Date(); // not stale, so only the webhook retry can catch it
    const r = await syncStale();
    expect(r.webhooksRetried).toBe(1);
    expect(rows("invoice")[0].status).toBe("CANCELLED");
    vi.mocked(console.error).mockRestore();
  });
});

describe("(e) a payment PayPal is holding (the buyer has paid, the money is not released)", () => {
  // Recorded from the sandbox: PayPal sent INVOICING.INVOICE.PAID for a payment whose invoice then read PAYMENT_PENDING
  // and whose capture was PENDING with reason RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION (src/paypal/fixtures).
  const held = "RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION";

  it("a PAID event for a held payment does not mark the invoice paid: it says so, and the agent waits", async () => {
    seed("SENT", { pending: ["send_invoice_reminder"] });
    h.paypal.set(PP_ID, { status: "PAYMENT_PENDING" });
    h.holdReason = held;
    expect(await deliver("paid")).toBe(true);
    expect(rows("invoice")[0]).toMatchObject({ status: "PAYMENT_PENDING", paidMinor: 0 });
    const all = timeline().join(" | ");
    expect(all).toMatch(/Payment received, held by PayPal\. PayPal is waiting for the receiving PayPal account to accept it/);
    expect(all).toMatch(/The agent is paused on this invoice \(no reminders, no rescheduling\) until PayPal completes it\./);
    expect(all).not.toMatch(/Paid in PayPal|reminders stopped/);
    expect(rows("proposedAction")[0].status).toBe("superseded"); // a reminder for a client who has already paid is moot
    expect(rows("case")[0].state).toBe("open"); // not resolved: the money has not arrived
    expect(rows("webhookEvent")[0].processed).toBe(true);
    expect(rows("timelineEvent").find((e) => e.kind === "payment_held")?.data).toEqual({ reason: held });
  });

  it("says plainly when PayPal gives an unfamiliar reason, or none", async () => {
    seed("SENT");
    h.paypal.set(PP_ID, { status: "PAYMENT_PENDING" });
    h.holdReason = "SOME_NEW_REASON";
    await deliver("paid");
    expect(timeline().join(" ")).toContain("PayPal's reason: some new reason.");
    h.tables = { invoice: [] };
    seed("SENT");
    h.holdReason = null;
    await deliver("paid");
    expect(timeline().join(" ")).toContain("Payment received, held by PayPal. PayPal didn't say why.");
  });

  it("polling backup: when PayPal completes the payment the invoice becomes paid, the case closes and the note says it cleared", async () => {
    seed("PAYMENT_PENDING");
    h.paypal.set(PP_ID, { status: "PAID", paid: "500.00" });
    const r = await syncStale(); // a held invoice is not closed, so it is re-read like any open one
    expect(r.synced).toBe(1);
    expect(rows("invoice")[0]).toMatchObject({ status: "PAID", paidMinor: 50_000 });
    expect(timeline()).toContain("Payment cleared: PayPal released the held payment. Paid, reminders stopped.");
    expect(timeline().join(" ")).not.toMatch(/outside ClearDue/);
    expect(rows("case")[0].state).toBe("resolved");
  });

  it("webhook: the same completion arriving as a verified event does the same", async () => {
    seed("PAYMENT_PENDING");
    h.paypal.set(PP_ID, { status: "PAID", paid: "500.00" });
    expect(await deliver("paid")).toBe(true);
    expect(rows("invoice")[0].status).toBe("PAID");
    expect(timeline().some((s) => s.startsWith("Payment cleared"))).toBe(true);
  });

  it("if PayPal releases it back to unpaid, the invoice is open again and says so", async () => {
    seed("PAYMENT_PENDING");
    h.paypal.set(PP_ID, { status: "SENT" });
    await syncStale();
    expect(rows("invoice")[0].status).toBe("SENT");
    expect(timeline()).toContain("PayPal did not complete the held payment, so the invoice is unpaid again. The agent can act on it again.");
  });

  it("a payment-capture event names its invoice in invoice_id, and is processed like an invoice event", async () => {
    seed("SENT");
    h.paypal.set(PP_ID, { status: "PAYMENT_PENDING" });
    h.holdReason = held;
    // Shape per PayPal's documentation (the webhook did not subscribe to these when the real payment happened).
    const event = { id: "WH-CAPTURE-1", event_type: "PAYMENT.CAPTURE.PENDING", resource: { id: "12Y361605S103763T", status: "PENDING", invoice_id: PP_ID } };
    expect(await handleWebhookEvent(event, { verified: true, process: true, note: null, source: "webhook" })).toBe(true);
    expect(rows("invoice")[0].status).toBe("PAYMENT_PENDING");
    expect(rows("webhookEvent")[0]).toMatchObject({ eventType: "PAYMENT.CAPTURE.PENDING", resourceId: PP_ID, processed: true });
  });
});
