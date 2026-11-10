"use client";

// The collections analyst dashboard: AG Studio with ClearDue's three custom widgets, a theme matching the rest of the
// app, a default report, and the analyst agent (a Client Tool Runner whose server side is /api/analyst/run).
import { Component, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { AgStudioAiModule, clientToolRunner, createAiHarness, studioTheme, type AgAiEvent, type AgAiRunInput, type AgDataSourcesDefinition, type AgReportState, type AgStudioApi } from "ag-studio";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import type { ClientRow, DecisionRow, InvoiceRow, PlanPartRow, ReceivableRow } from "@/agent/analyst";
import type { PaymentRow } from "@/paypal/transactions";
import { CUSTOM_WIDGETS } from "./widgets";

const PAGE = "analyst";

/** Our shadcn tokens (neutral palette, system font, 12px corners) as Studio theme parameters. */
const theme = studioTheme.withParams({
  fontFamily: "inherit",
  backgroundColor: "#ffffff",
  textColor: "#0a0a0a",
  borderColor: "#e5e5e5",
  studioCanvasBackgroundColor: "#fafafa",
  studioAiPanelWidth: 320,
  studioMinWidth: 320,
  studioCanvasMinWidth: 320,
  studioPanelWidth: 230,
  studioCanvasFontFamily: "inherit",
  studioWidgetBackgroundColor: "#ffffff",
  studioWidgetBorder: [1, "#e5e5e5"],
  studioWidgetBorderRadius: 12,
  studioWidgetPadding: 0,
  studioWidgetTitleFontFamily: "inherit",
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleFontWeight: 600,
  studioWidgetTitleTextColor: "#0a0a0a",
  studioWidgetSubtitleFontFamily: "inherit",
  studioWidgetSubtitleTextColor: "#737373",
  studioToggleButtonActiveBackgroundColor: "#171717",
  studioToggleButtonActiveBorderColor: "#171717",
  studioToggleButtonActiveColor: "#ffffff",
  chartFontFamily: "inherit",
  chartTextColor: "#0a0a0a",
  chartSubtleTextColor: "#737373",
} as never);

const widgets = createWidgets({ additionalTypes: CUSTOM_WIDGETS as never, menu: [{ label: "ClearDue", widgetIds: ["owes", "decisions", "plans", "median-days"] as never }, { label: "Standard", widgetIds: ["grid", "value", "bar-chart-grouped", "pie-chart", "button-filter", "date-filter"] as never }], defaultType: "grid" } as never);

const fieldsOf = (source: string, names: string[]) => names.map((n) => ({ id: `${source}.${n}` }));
const title = (text: string, subtitle: string) => ({ title: { enabled: true, text }, subtitle: { enabled: true, text: subtitle } });

const kpi = (text: string, subtitle: string) => ({ ...title(text, subtitle), style: { typography: { fontSize: 34, fontWeight: "bold" }, verticalAlign: "center" } });

/** The report Studio opens with, so nobody starts on an empty canvas: four KPIs (collection rate, median days to paid,
 * recovered this month, and payments received as PayPal itself records them), a client picker and a date range that filter every widget, overdue invoices by reason, and
 * the three ClearDue widgets. Laid out on the 24-column canvas, stacked on a phone. */
const initialStateFor = (narrow: boolean, live: boolean) => ({
  selectedPageId: PAGE,
  pages: [
    {
      id: PAGE,
      widgets: {
        collectionRate: { type: "value", dataMapping: { value: [{ id: "collectionRate" }] }, format: kpi("Collection rate", "Paid invoices ÷ issued invoices") },
        medianDays: { type: "median-days", dataMapping: { fields: fieldsOf("invoices", ["invoice", "daysToPaid"]) }, format: title("Median days to paid", "From issue date to payment") },
        recovered: { type: "value", dataMapping: { value: [{ id: "invoices.recoveredThisMonth", aggregation: "sum" }] }, format: kpi("Recovered this month", "Overdue invoices paid since the 1st") },
        ...(live && { paypalReceived: { type: "value", dataMapping: { value: [{ id: "paypalPayments.count", aggregation: "sum" }] }, format: kpi("Received in PayPal", "Payments in the last 90 days, live from PayPal") } }),
        period: { type: "date-filter", dataMapping: { value: [{ id: "invoices.issued" }] }, format: { ...title("Issued between", "Set both dates; every widget follows"), style: { filterType: "between" } } },
        clientFilter: { type: "button-filter", dataMapping: { value: [{ id: "clients.client" }] }, format: { ...title("Client", "Click one to filter the whole page"), style: { selection: { type: "single" }, defaultItem: { backgroundColor: "#ffffff", color: "#0a0a0a" }, activeItem: { backgroundColor: "#1f3fff", color: "#ffffff" } } } },
        overdueByReason: { type: "bar-chart-grouped", dataMapping: { categoryKey: [{ id: "receivables.reason" }], valueKey: [{ id: "receivables.overdue", aggregation: "sum" }] }, format: title("Overdue by reason", "Overdue invoices, by the diagnosed reason") },
        owes: { type: "owes", dataMapping: { fields: fieldsOf("receivables", ["client", "invoice", "currency", "outstanding", "daysOverdue", "reason", "nextAction"]) }, format: title("Who still owes what", "Open invoices, most overdue first") },
        decisions: { type: "decisions", dataMapping: { fields: fieldsOf("decisions", ["client", "action", "verdict", "outcome", "reasons", "date"]) }, format: title("Mandate decisions", "The model proposes, the mandate decides") },
        plans: { type: "plans", dataMapping: { fields: fieldsOf("plans", ["client", "plan", "strategy", "part", "amount", "currency", "due", "status", "paid"]) }, format: title("Plan tracker", "Instalments paid and still to pay") },
      },
      widgetLayout: narrow
        ? live
          ? {
              collectionRate: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 8 },
              medianDays: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 8 },
              recovered: { xTrack: 0, yTrack: 8, xSpan: 12, ySpan: 8 },
              paypalReceived: { xTrack: 12, yTrack: 8, xSpan: 12, ySpan: 8 },
              clientFilter: { xTrack: 0, yTrack: 16, xSpan: 24, ySpan: 8 },
              period: { xTrack: 0, yTrack: 24, xSpan: 24, ySpan: 8 },
              overdueByReason: { xTrack: 0, yTrack: 32, xSpan: 24, ySpan: 14 },
              owes: { xTrack: 0, yTrack: 46, xSpan: 24, ySpan: 20 },
              decisions: { xTrack: 0, yTrack: 66, xSpan: 24, ySpan: 30 },
              plans: { xTrack: 0, yTrack: 96, xSpan: 24, ySpan: 24 },
            }
          : {
              collectionRate: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 8 },
              medianDays: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 8 },
              recovered: { xTrack: 0, yTrack: 8, xSpan: 12, ySpan: 8 },
              clientFilter: { xTrack: 12, yTrack: 8, xSpan: 12, ySpan: 8 },
              period: { xTrack: 0, yTrack: 16, xSpan: 24, ySpan: 8 },
              overdueByReason: { xTrack: 0, yTrack: 22, xSpan: 24, ySpan: 14 },
              owes: { xTrack: 0, yTrack: 36, xSpan: 24, ySpan: 20 },
              decisions: { xTrack: 0, yTrack: 56, xSpan: 24, ySpan: 30 },
              plans: { xTrack: 0, yTrack: 86, xSpan: 24, ySpan: 24 },
            }
        : {
            collectionRate: { xTrack: 0, yTrack: 0, xSpan: live ? 6 : 8, ySpan: 8 },
            medianDays: { xTrack: live ? 6 : 8, yTrack: 0, xSpan: live ? 6 : 8, ySpan: 8 },
            recovered: { xTrack: live ? 12 : 16, yTrack: 0, xSpan: live ? 6 : 8, ySpan: 8 },
            ...(live && { paypalReceived: { xTrack: 18, yTrack: 0, xSpan: 6, ySpan: 8 } }),
            clientFilter: { xTrack: 0, yTrack: 8, xSpan: 6, ySpan: 12 },
            period: { xTrack: 0, yTrack: 20, xSpan: 6, ySpan: 10 },
            overdueByReason: { xTrack: 6, yTrack: 8, xSpan: 18, ySpan: 22 },
            owes: { xTrack: 0, yTrack: 30, xSpan: 24, ySpan: 18 },
            decisions: { xTrack: 0, yTrack: 48, xSpan: 12, ySpan: 30 },
            plans: { xTrack: 12, yTrack: 48, xSpan: 12, ySpan: 30 },
          },
    },
  ],
}) as unknown as AgReportState;

/** POSTs the run input to our server and yields its NDJSON lines as AG-UI events. */
async function* serverRun(input: AgAiRunInput, signal?: AbortSignal): AsyncGenerator<AgAiEvent> {
  const res = await fetch("/api/analyst/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal });
  if (!res.ok || !res.body) {
    yield { type: "RUN_ERROR", message: res.status === 429 ? "Too many questions, wait a minute." : `ClearDue analyst returned ${res.status}` };
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) yield JSON.parse(line) as AgAiEvent;
  }
}

const NARROW = "(max-width: 767px)";
const subscribeNarrow = (cb: () => void) => {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

const text = "textFormat";
const int = "integerFormat";
const dec = "decimalFormat";

/** If Studio itself throws (a bad or expired key it refuses, a widget bug), the rest of the app keeps working. */
class StudioBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("[analyst] AG Studio failed to render", error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="rounded-lg border px-4 py-6 text-sm">
        <p className="font-medium">The analyst report couldn&apos;t load.</p>
        <p className="mt-1 text-muted-foreground">Your invoices are safe and every other page works. Check the AG Studio licence key (AG_STUDIO), then reload.</p>
      </div>
    );
  }
}

interface Props {
  licenseKey?: string;
  clients: ClientRow[];
  invoices: InvoiceRow[];
  receivables: ReceivableRow[];
  decisions: DecisionRow[];
  plans: PlanPartRow[];
  /** Live from PayPal Transaction Search (empty when that call failed; the page says why), or null when
   * LIVE_PAYPAL_PAYMENTS is off: then there is no source, KPI or relationship at all. */
  payments: PaymentRow[] | null;
}

/** Studio's widgets carry no stable id in the DOM, so the tour's target (data-tour="collection-rate") is put on the
 * collection-rate KPI by its title once Studio has drawn it. */
function useTourTarget() {
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      const title = [...document.querySelectorAll(".ag-studio-layout-widget-title")].find((t) => t.textContent?.trim() === "Collection rate");
      const widget = title?.closest(".ag-studio-layout-widget");
      if (widget) widget.setAttribute("data-tour", "collection-rate");
      if (widget || Date.now() - started > 20_000) clearInterval(timer);
    }, 150);
    return () => clearInterval(timer);
  }, []);
}

export function AnalystStudio({ licenseKey, clients, invoices, receivables, decisions, plans, payments }: Props) {
  useTourTarget();
  const data = useMemo<AgDataSourcesDefinition>(
    () =>
      ({
        description:
          `A freelancer's receivables. invoices is the hub: receivables, decisions and plans join to it by invoiceId, and clients join to it by clientId, so a client or date filter narrows every table.${payments ? " paypalPayments is different: it comes live from PayPal's Transaction Search (the last 90 days of money received), not from ClearDue's records, and joins to invoices by invoice number." : ""} Amounts are in each invoice's own currency and are never summed across currencies.`,
        sources: [
          {
            id: "clients",
            description: "The freelancer's clients.",
            data: clients,
            fields: [
              { id: "clientId", name: "Client id", format: text, hide: true },
              { id: "client", name: "Client", format: text },
            ],
          },
          {
            id: "invoices",
            description: "Every invoice sent through PayPal, with whether and how fast it was paid. A plan's replaced original has issuedCount 0.",
            data: invoices,
            fields: [
              { id: "invoiceId", name: "Invoice id", format: text, hide: true },
              { id: "clientId", name: "Invoice client id", format: text, hide: true },
              { id: "client", name: "Invoice client", format: text },
              { id: "invoice", name: "Invoice number", format: text },
              { id: "issued", name: "Issued", format: "dateFormat" },
              { id: "status", name: "Invoice status", format: text },
              { id: "issuedCount", name: "Issued (count)", format: int },
              { id: "paidCount", name: "Paid (count)", format: int },
              { id: "daysToPaid", name: "Days to paid", format: int },
              { id: "recoveredThisMonth", name: "Recovered this month", format: int },
            ],
          },
          {
            id: "receivables",
            description: "Open invoices with the diagnosed reason and the next action.",
            data: receivables,
            fields: [
              { id: "invoiceId", name: "Receivable invoice id", format: text, hide: true },
              { id: "overdue", name: "Overdue (count)", format: int },
              { id: "client", name: "Client", format: text },
              { id: "invoice", name: "Invoice", format: text },
              { id: "currency", name: "Currency", format: text },
              { id: "outstanding", name: "Outstanding", format: dec },
              { id: "daysOverdue", name: "Days overdue", format: int },
              { id: "status", name: "Status", format: text },
              { id: "reason", name: "Diagnosed reason", format: text },
              { id: "nextAction", name: "Next action", format: text },
            ],
          },
          {
            id: "decisions",
            description: "Agent proposals and what the mandate decided about each.",
            data: decisions,
            fields: [
              { id: "invoiceId", name: "Decision invoice id", format: text, hide: true },
              { id: "client", name: "Client", format: text },
              { id: "action", name: "Action", format: text },
              { id: "verdict", name: "Mandate verdict", format: text },
              { id: "outcome", name: "Outcome", format: text },
              { id: "reasons", name: "Reasons", format: text },
              { id: "date", name: "Date", format: text },
            ],
          },
          {
            id: "plans",
            description: "Payment plan instalments and whether each is paid.",
            data: plans,
            fields: [
              { id: "invoiceId", name: "Plan invoice id", format: text, hide: true },
              { id: "client", name: "Client", format: text },
              { id: "plan", name: "Plan", format: text },
              { id: "strategy", name: "Strategy", format: text },
              { id: "part", name: "Part", format: text },
              { id: "currency", name: "Currency", format: text },
              { id: "amount", name: "Amount", format: dec },
              { id: "due", name: "Due", format: text },
              { id: "status", name: "Status", format: text },
              { id: "paid", name: "Paid", format: int },
            ],
          },
          ...(payments ? [{
            id: "paypalPayments",
            description: "Payments received in the last 90 days, live from PayPal Transaction Search (not ClearDue's records). PayPal can run up to three hours behind. invoiceNumber is empty when the payment wasn't for an invoice.",
            // Studio infers types from the first values, so missing text is "" rather than null.
            data: payments.map((r) => ({ ...r, invoiceNumber: r.invoiceNumber ?? "", payer: r.payer ?? "", date: r.date.slice(0, 10), count: 1 })),
            fields: [
              { id: "id", name: "PayPal transaction id", format: text, hide: true },
              { id: "date", name: "Received (PayPal)", format: text },
              { id: "payer", name: "Payer (PayPal)", format: text },
              { id: "invoiceNumber", name: "Invoice number (PayPal)", format: text },
              { id: "amount", name: "Amount received (PayPal)", format: dec },
              { id: "currency", name: "Currency (PayPal)", format: text },
              { id: "status", name: "Payment status (PayPal)", format: text },
              { id: "count", name: "Payments (PayPal)", format: int },
              { id: "amountMinor", name: "Amount in minor units", format: int, hide: true },
            ],
          }] : []),
        ],
        // A star around invoices, so every widget is reachable from a client or a date by exactly one path.
        relationships: [
          ...(payments ? [{ id: "invoice-paypal-payments", source: { tableId: "invoices", fieldId: "invoice" }, target: { tableId: "paypalPayments", fieldId: "invoiceNumber" }, type: "one-to-many" as const }] : []),
          { id: "client-invoices", source: { tableId: "clients", fieldId: "clientId" }, target: { tableId: "invoices", fieldId: "clientId" }, type: "one-to-many" },
          { id: "invoice-receivable", source: { tableId: "invoices", fieldId: "invoiceId" }, target: { tableId: "receivables", fieldId: "invoiceId" }, type: "one-to-one" },
          { id: "invoice-decisions", source: { tableId: "invoices", fieldId: "invoiceId" }, target: { tableId: "decisions", fieldId: "invoiceId" }, type: "one-to-many" },
          { id: "invoice-plan-part", source: { tableId: "invoices", fieldId: "invoiceId" }, target: { tableId: "plans", fieldId: "invoiceId" }, type: "one-to-one" },
        ],
        expressions: [
          {
            id: "collectionRate",
            name: "Collection rate",
            description: "Paid invoices divided by issued invoices.",
            isMeasure: true,
            format: "percentageFormat",
            expression: { operator: "divide", inputs: [{ id: "invoices.paidCount", aggregation: "sum" }, { id: "invoices.issuedCount", aggregation: "sum" }] },
          },
        ],
      }) as unknown as AgDataSourcesDefinition,
    [clients, invoices, receivables, decisions, plans, payments],
  );

  // The widget editor is hidden until asked for, so the report gets the room; the AI panel is always there.
  // On a phone the AI panel would fill the screen, so it opens only on request and the widget editor isn't offered.
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const narrow = useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false);
  const [initialState] = useState(() => initialStateFor(typeof window !== "undefined" && window.matchMedia(NARROW).matches, payments !== null));
  const panels = useMemo(() => ({ edit: { left: !narrow || asking ? ["ai"] : [], right: editing && !narrow ? ["edit"] : [] } }), [editing, narrow, asking]);

  const ai = useMemo(
    () =>
      ({ api }: { api: AgStudioApi }) => {
        const analyst = clientToolRunner({
          id: "analyst",
          name: "Collections analyst",
          description: "Answers questions about ClearDue receivables, the mandate's decisions and payment plans, and proposes actions for the freelancer to approve.",
          instructions: () => "You are ClearDue's collections analyst.",
          tools: () => [],
          run: (input, ctx) => serverRun(input, ctx.signal),
        });
        return createAiHarness(api, () => ({
          agents: [analyst],
          primary: "analyst",
          promptStarters: [
            { label: "Who owes me money?", prompt: "Who owes me money, and what should I do first?" },
            { label: "How did the mandate decide?", prompt: "How many of the agent's proposals did the mandate allow, hold for approval or block?" },
            { label: "Chase the most overdue", prompt: "Draft a friendly nudge for the most overdue invoice and propose it for my approval." },
          ],
        }));
      },
    [],
  );

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        {narrow ? (
          <button type="button" onClick={() => setAsking((a) => !a)} aria-pressed={asking} className="rounded-md border px-3 py-1 text-sm hover:bg-muted">
            {asking ? "Back to the report" : "Ask the analyst"}
          </button>
        ) : (
          <button type="button" onClick={() => setEditing((e) => !e)} aria-pressed={editing} className="rounded-md border px-3 py-1 text-sm hover:bg-muted">
            {editing ? "Done editing" : "Edit layout"}
          </button>
        )}
      </div>
      <div className={narrow ? "h-[1250px]" : "h-[calc(100vh-12rem)] min-h-[640px]"}>
      <StudioBoundary>
      <AgStudioProvider modules={[AgStudioAiModule]} licenseKey={licenseKey}>
        <AgStudio style={{ height: "100%", width: "100%" }} mode="edit" panels={panels as never} data={data} initialState={initialState} widgets={widgets as never} theme={theme as never} ai={ai} />
      </AgStudioProvider>
      </StudioBoundary>
      </div>
    </div>
  );
}
