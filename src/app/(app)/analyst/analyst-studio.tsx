"use client";

// SPIKE (spike/ag-studio): AG Studio with one custom agent ("Collections analyst") whose custom tool calls a
// ClearDue endpoint and renders the result in Studio as a grid widget. No widgets, theming or polish yet.
import { useMemo, useState } from "react";
import { AgStudioAiModule, clientToolRunner, createAiHarness, type AgAiEvent, type AgAiRunInput, type AgDataSourcesDefinition, type AgReportState, type AgStudioApi } from "ag-studio";
import { AgStudio, AgStudioProvider } from "ag-studio-react";

interface Row {
  client: string;
  invoice: string;
  currency: string;
  outstanding: number;
  daysOverdue: number;
  reason: string;
}

const PAGE = "analyst";
const initialState: AgReportState = { selectedPageId: PAGE, pages: [{ id: PAGE, widgets: {}, widgetLayout: {} }] };

/** POSTs the run input to our server and yields its NDJSON lines as AG-UI events. */
async function* serverRun(input: AgAiRunInput, signal?: AbortSignal): AsyncGenerator<AgAiEvent> {
  const res = await fetch("/api/analyst/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal });
  if (!res.ok || !res.body) {
    yield { type: "RUN_ERROR", message: `ClearDue analyst returned ${res.status}` };
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

/** Adds (or replaces) a grid of the receivables source on the analyst page. */
function showGrid(api: AgStudioApi) {
  const state = api.getState();
  const pages = state.pages.map((p) =>
    p.id !== PAGE
      ? p
      : {
          ...p,
          widgets: {
            ...p.widgets,
            receivables: {
              type: "grid",
              dataMapping: { cols: ["client", "invoice", "currency", "reason", "daysOverdue"].map((f) => ({ id: `receivables.${f}` })).concat([{ id: "receivables.outstanding", aggregation: "sum" } as never]) },
              sort: [{ field: { id: "receivables.daysOverdue" }, direction: "desc" }],
              format: { title: { enabled: true, text: "Open invoices from ClearDue (via the analyst's tool)" } },
            },
          },
          widgetLayout: { ...p.widgetLayout, receivables: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 16 } },
        },
  );
  api.setState({ ...state, pages } as AgReportState);
}

export function AnalystStudio() {
  const [rows, setRows] = useState<Row[]>([]);
  const data = useMemo<AgDataSourcesDefinition>(
    () => ({
      sources: [
        {
          id: "receivables",
          description: "ClearDue open invoices, loaded by the analyst's get_receivables tool.",
          data: rows,
          fields: [
            { id: "client", name: "Client", format: "textFormat" },
            { id: "invoice", name: "Invoice", format: "textFormat" },
            { id: "currency", name: "Currency", format: "textFormat" },
            { id: "reason", name: "Diagnosed reason", format: "textFormat" },
            { id: "daysOverdue", name: "Days overdue", format: "integerFormat" },
            { id: "outstanding", name: "Outstanding", format: "decimalFormat" },
          ],
        },
      ],
    }),
    [rows],
  );

  const ai = useMemo(
    () =>
      ({ api }: { api: AgStudioApi }) => {
        const getReceivables = api.defineAiTool({
          name: "get_receivables",
          description: "Fetch ClearDue's open invoices (client, amount outstanding, days overdue, diagnosed reason) and show them on the page.",
          params: (s) => s.object({}),
          execute: async (_args: unknown, ctx) => {
            const res = await fetch("/api/analyst/receivables", { signal: ctx.signal });
            if (!res.ok) return ctx.error(`ClearDue returned ${res.status}`);
            const fetched = (await res.json()) as Row[];
            setRows(fetched);
            // Let React pass the new data to Studio before the widget that reads it is added.
            await new Promise((r) => setTimeout(r, 0));
            showGrid(api);
            return ctx.success(`${fetched.length} open invoices`, fetched);
          },
        });
        const analyst = clientToolRunner({
          id: "analyst",
          name: "Collections analyst",
          description: "Answers questions about ClearDue receivables.",
          instructions: () => "You are ClearDue's collections analyst.",
          tools: () => [getReceivables],
          run: (input, ctx) => serverRun(input, ctx.signal),
        });
        return createAiHarness(api, () => ({
          agents: [analyst],
          primary: "analyst",
          promptStarters: [{ label: "Who owes me money?", prompt: "Who owes me money?" }],
        }));
      },
    [],
  );

  return (
    <div className="h-[80vh] min-h-[600px]">
      <AgStudioProvider modules={[AgStudioAiModule]}>
        <AgStudio style={{ height: "100%", width: "100%" }} mode="edit" data={data} initialState={initialState} ai={ai} />
      </AgStudioProvider>
    </div>
  );
}
