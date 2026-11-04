"use client";

// The collections analyst dashboard: AG Studio with ClearDue's three custom widgets, a theme matching the rest of the
// app, a default report, and the analyst agent (a Client Tool Runner whose server side is /api/analyst/run).
import { useMemo, useState, useSyncExternalStore } from "react";
import { AgStudioAiModule, clientToolRunner, createAiHarness, studioTheme, type AgAiEvent, type AgAiRunInput, type AgDataSourcesDefinition, type AgReportState, type AgStudioApi } from "ag-studio";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import type { DecisionRow, PlanPartRow, ReceivableRow } from "@/agent/analyst";
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

const widgets = createWidgets({ additionalTypes: CUSTOM_WIDGETS as never, menu: [{ label: "ClearDue", widgetIds: ["owes", "decisions", "plans"] as never }, { label: "Standard", widgetIds: ["grid", "value", "bar-chart-grouped", "pie-chart", "list-filter"] as never }], defaultType: "grid" } as never);

const fieldsOf = (source: string, names: string[]) => names.map((n) => ({ id: `${source}.${n}` }));
const title = (text: string, subtitle: string) => ({ title: { enabled: true, text }, subtitle: { enabled: true, text: subtitle } });

/** The report Studio opens with: the three ClearDue widgets, laid out on the 24-column canvas (stacked on a phone). */
const initialStateFor = (narrow: boolean) => ({
  selectedPageId: PAGE,
  pages: [
    {
      id: PAGE,
      widgets: {
        owes: { type: "owes", dataMapping: { fields: fieldsOf("receivables", ["client", "invoice", "currency", "outstanding", "daysOverdue", "reason", "nextAction"]) }, format: title("Who still owes what", "Open invoices, most overdue first") },
        decisions: { type: "decisions", dataMapping: { fields: fieldsOf("decisions", ["client", "action", "verdict", "outcome", "reasons", "date"]) }, format: title("Mandate decisions", "The model proposes, the mandate decides") },
        plans: { type: "plans", dataMapping: { fields: fieldsOf("plans", ["client", "plan", "strategy", "part", "amount", "currency", "due", "status", "paid"]) }, format: title("Plan tracker", "Instalments paid and still to pay") },
      },
      widgetLayout: narrow
        ? {
            owes: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 20 },
            decisions: { xTrack: 0, yTrack: 20, xSpan: 24, ySpan: 30 },
            plans: { xTrack: 0, yTrack: 50, xSpan: 24, ySpan: 24 },
          }
        : {
            owes: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 14 },
            decisions: { xTrack: 0, yTrack: 14, xSpan: 12, ySpan: 30 },
            plans: { xTrack: 12, yTrack: 14, xSpan: 12, ySpan: 30 },
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

export function AnalystStudio({ licenseKey, receivables, decisions, plans }: { licenseKey?: string; receivables: ReceivableRow[]; decisions: DecisionRow[]; plans: PlanPartRow[] }) {
  const data = useMemo<AgDataSourcesDefinition>(
    () =>
      ({
        sources: [
          {
            id: "receivables",
            description: "Open invoices with the diagnosed reason and the next action.",
            data: receivables,
            fields: [
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
        ],
      }) as unknown as AgDataSourcesDefinition,
    [receivables, decisions, plans],
  );

  // The widget editor is hidden until asked for, so the report gets the room; the AI panel is always there.
  // On a phone the AI panel would fill the screen, so it opens only on request and the widget editor isn't offered.
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const narrow = useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches, () => false);
  const [initialState] = useState(() => initialStateFor(typeof window !== "undefined" && window.matchMedia(NARROW).matches));
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
      <AgStudioProvider modules={[AgStudioAiModule]} licenseKey={licenseKey}>
        <AgStudio style={{ height: "100%", width: "100%" }} mode="edit" panels={panels as never} data={data} initialState={initialState} widgets={widgets as never} theme={theme as never} ai={ai} />
      </AgStudioProvider>
      </div>
    </div>
  );
}
