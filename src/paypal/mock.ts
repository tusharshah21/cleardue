// PAYPAL_MODE=mock: an in-process stand-in for the Invoicing API v2, so every flow (including the Agent Toolkit
// tools, which are routed through src/paypal in this mode) works locally without sandbox credentials.
// State lives in a JSON file so the seed script and the dev server share it. Dev and tests only.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface Money {
  currency_code: string;
  value: string;
}
interface MockItem {
  name: string;
  quantity: string;
  unit_amount: Money;
}
export interface MockInvoice {
  id: string;
  status: string;
  detail: { invoice_number: string; currency_code: string; payment_term?: { due_date?: string }; metadata: { recipient_view_url?: string } };
  primary_recipients?: unknown[];
  items: MockItem[];
  configuration?: { partial_payment?: { allow_partial_payment?: boolean; minimum_amount_due?: Money } };
  amount: Money;
  due_amount: Money;
  payments?: { paid_amount: Money; transactions: { payment_id: string; amount: Money; method: string }[] };
  reminders: { at: string; additional_recipients: string[]; note?: string }[];
}
interface Store {
  seq: number;
  invoices: Record<string, MockInvoice>;
}

const file = () => process.env.PAYPAL_MOCK_FILE || ".paypal-mock.json";
const load = (): Store => (existsSync(file()) ? (JSON.parse(readFileSync(file(), "utf8")) as Store) : { seq: 0, invoices: {} });
const save = (s: Store) => writeFileSync(file(), JSON.stringify(s, null, 2));

export function resetMock() {
  save({ seq: 0, invoices: {} });
}

// Mock amounts are kept in cents; every PayPal-facing value is a 2-decimal string (zero-decimal currencies aren't mocked).
const cents = (v: string) => Math.round(Number(v) * 100);
const money = (currency: string, c: number): Money => ({ currency_code: currency, value: (c / 100).toFixed(2) });
const total = (inv: MockInvoice) => inv.items.reduce((s, i) => s + Math.round(Number(i.quantity) * cents(i.unit_amount.value)), 0);
const paid = (inv: MockInvoice) => (inv.payments ? cents(inv.payments.paid_amount.value) : 0);

/** PayPal doesn't allow partial payments for merchants in these countries; the mock merchant defaults to India. */
const NO_PARTIAL = ["IN", "BR", "IL"];

export interface MockResponse {
  status: number;
  body?: unknown;
}
const error = (status: number, name: string, message: string, issue?: string): MockResponse => ({
  status,
  body: { name, message, debug_id: "mock", ...(issue && { details: [{ issue, description: message }] }) },
});
const notFound = () => error(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.", "INVALID_RESOURCE_ID");
const badStatus = (inv: MockInvoice, action: string) =>
  error(422, "UNPROCESSABLE_ENTITY", `Cannot ${action} an invoice in status ${inv.status}.`, "INVALID_INVOICE_STATUS");

function build(id: string, number: string, body: Record<string, unknown>): MockInvoice {
  const detail = body.detail as MockInvoice["detail"];
  const items = (body.items as MockItem[]) ?? [];
  const inv: MockInvoice = {
    id,
    status: "DRAFT",
    detail: { ...detail, invoice_number: number, metadata: {} },
    primary_recipients: body.primary_recipients as unknown[],
    items,
    configuration: body.configuration as MockInvoice["configuration"],
    amount: money(detail.currency_code, 0),
    due_amount: money(detail.currency_code, 0),
    reminders: [],
  };
  return refresh(inv);
}

function refresh(inv: MockInvoice): MockInvoice {
  const c = inv.detail.currency_code;
  inv.amount = money(c, total(inv));
  inv.due_amount = money(c, Math.max(0, total(inv) - paid(inv)));
  return inv;
}

const ROUTE = /^\/v2\/invoicing\/invoices(?:\/([^/?]+))?(?:\/(send|remind|cancel|payments))?(?:\?.*)?$/;

/** Handles one Invoicing API request the way the sandbox would. */
export function mockRequest(method: string, path: string, body: unknown): MockResponse {
  const m = ROUTE.exec(path);
  if (!m) return error(404, "NOT_FOUND", `The mock doesn't implement ${method} ${path}`);
  const [, id, action] = m;
  const store = load();
  const b = (body ?? {}) as Record<string, unknown>;
  const done = (r: MockResponse) => {
    save(store);
    return r;
  };

  if (!id && method === "POST") {
    const detail = b.detail as { currency_code?: string } | undefined;
    if (!detail?.currency_code || !Array.isArray(b.items) || !b.items.length) return error(400, "INVALID_REQUEST", "detail.currency_code and items are required.", "MISSING_REQUIRED_PARAMETER");
    const partial = (b.configuration as MockInvoice["configuration"])?.partial_payment?.allow_partial_payment;
    if (partial && NO_PARTIAL.includes((process.env.PAYPAL_MOCK_COUNTRY || "IN").toUpperCase())) {
      return error(422, "UNPROCESSABLE_ENTITY", "Partial payments are not supported for this merchant's country.", "PARTIAL_PAYMENT_NOT_ALLOWED");
    }
    store.seq++;
    const inv = build(`INV2-MOCK-${randomBytes(6).toString("hex").toUpperCase()}`, String(store.seq).padStart(4, "0"), b);
    store.invoices[inv.id] = inv;
    return done({ status: 201, body: inv });
  }

  const inv = id ? store.invoices[id] : undefined;
  if (!inv) return notFound();

  if (!action) {
    if (method === "GET") return { status: 200, body: inv };
    if (method === "PUT") {
      if (!["DRAFT", "SENT", "UNPAID"].includes(inv.status)) return badStatus(inv, "update");
      const next = build(inv.id, inv.detail.invoice_number, b);
      store.invoices[inv.id] = { ...next, status: inv.status, detail: { ...next.detail, metadata: inv.detail.metadata }, payments: inv.payments, reminders: inv.reminders };
      return done({ status: 200, body: store.invoices[inv.id] });
    }
    if (method === "DELETE") {
      if (inv.status !== "DRAFT") return badStatus(inv, "delete");
      delete store.invoices[inv.id];
      return done({ status: 204 });
    }
  }
  if (method !== "POST") return error(405, "METHOD_NOT_SUPPORTED", `${method} is not supported here.`);

  switch (action) {
    case "send": {
      if (inv.status !== "DRAFT") return badStatus(inv, "send");
      inv.status = "SENT";
      const href = `${process.env.APP_URL || "http://localhost:3000"}/dev/paypal/${inv.id}`;
      inv.detail.metadata.recipient_view_url = href;
      return done({ status: 200, body: { rel: "payer-view", href, method: "GET" } });
    }
    case "remind":
      if (!["SENT", "UNPAID", "PARTIALLY_PAID"].includes(inv.status)) return badStatus(inv, "remind");
      inv.reminders.push({ at: new Date().toISOString(), additional_recipients: (b.additional_recipients as string[]) ?? [], note: b.note as string | undefined });
      return done({ status: 204 });
    case "cancel":
      if (!["SENT", "UNPAID", "SCHEDULED"].includes(inv.status)) return badStatus(inv, "cancel");
      inv.status = "CANCELLED";
      return done({ status: 204 });
    case "payments": {
      if (!["SENT", "UNPAID", "PARTIALLY_PAID"].includes(inv.status)) return badStatus(inv, "record a payment on");
      const amount = b.amount as Money | undefined;
      if (!amount?.value || amount.currency_code !== inv.detail.currency_code) return error(400, "INVALID_REQUEST", "amount must be in the invoice currency.", "INVALID_PARAMETER_VALUE");
      const c = cents(amount.value);
      const due = total(inv) - paid(inv);
      if (c <= 0 || c > due) return error(422, "UNPROCESSABLE_ENTITY", "Payment amount must be positive and no more than the amount due.", "INVALID_PAYMENT_AMOUNT");
      const payment_id = `MOCKPAY${randomBytes(6).toString("hex").toUpperCase()}`;
      const transactions = [...(inv.payments?.transactions ?? []), { payment_id, amount, method: String(b.method ?? "PAYPAL") }];
      inv.payments = { paid_amount: money(inv.detail.currency_code, paid(inv) + c), transactions };
      inv.status = paid(inv) >= total(inv) ? "PAID" : "PARTIALLY_PAID";
      refresh(inv);
      return done({ status: 200, body: { payment_id } });
    }
  }
  return error(404, "NOT_FOUND", `Unknown action ${action}`);
}

export function mockInvoice(id: string): MockInvoice | undefined {
  return load().invoices[id];
}
