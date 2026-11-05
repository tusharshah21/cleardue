"use client";

// The three custom AG Studio widgets of the collections analyst dashboard. Each is a React component Studio mounts on
// the canvas, fed by whatever fields the report maps to it, so they work with Studio's filters, editor and AI like the
// built-in widgets do. Fields are matched by their display name, which the data sources in analyst-studio.tsx define.
import { useEffect, useState } from "react";
import type { AgWidgetField, AgWidgetParams } from "ag-studio";
import type { AgWidgetDefinition } from "ag-studio-react";

type Row = Record<string, unknown>;
type Params = AgWidgetParams<{ dataMapping: { fields: unknown }; format?: never }>;

/** Rows for the fields mapped to this widget, keyed by the field's display name. Re-runs when filters change. */
function useRows(params: Params): Row[] | null {
  const fields = ((params.dataMapping as { fields?: AgWidgetField[] }).fields ?? []) as AgWidgetField[];
  const [rows, setRows] = useState<Row[] | null>(null);
  const signature = fields.map((f) => f.key).join(",");
  useEffect(() => {
    let live = true;
    if (!fields.length) return;
    params.widgetApi.getData({ fields }).then((res) => {
      if (!live) return;
      setRows(res.results.rows.map((r) => Object.fromEntries(fields.map((f) => [f.name, r[f.key]]))));
    });
    return () => {
      live = false;
    };
    // The fields array changes identity every render; its keys are what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, params.widgetApi]);
  return fields.length ? rows : [];
}

const money = (amount: unknown, currency: unknown) => {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: String(currency || "USD") }).format(Number(amount));
  } catch {
    return String(amount);
  }
};

const REASON_TONE: Record<string, string> = {
  "Not diagnosed": "bg-muted text-muted-foreground",
  "Awaiting approval": "bg-sky-100 text-sky-800",
  "Cash constraint": "bg-amber-100 text-amber-800",
  "Dispute": "bg-red-100 text-red-800",
  "Forgot": "bg-slate-100 text-slate-700",
  "Wrong contact": "bg-violet-100 text-violet-800",
  "Promised date": "bg-emerald-100 text-emerald-800",
  "Claims paid": "bg-teal-100 text-teal-800",
};

function Empty({ text }: { text: string }) {
  return <p className="p-4 text-sm text-muted-foreground">{text}</p>;
}

/** 1. Who still owes what: one line per open invoice, most overdue first, the reason coloured, the next action spelled out. */
function OwesWidget(params: Params) {
  const rows = useRows(params);
  if (!rows) return <Empty text="Loading…" />;
  if (!rows.length) return <Empty text="Nothing owed, or no fields mapped to this widget yet." />;
  const sorted = [...rows].sort((a, b) => Number(b["Days overdue"] ?? 0) - Number(a["Days overdue"] ?? 0));
  return (
    <ul className="divide-y overflow-auto" style={{ height: "100%" }}>
      {sorted.map((r, i) => {
        const late = Number(r["Days overdue"] ?? 0);
        const reason = String(r["Diagnosed reason"] ?? "");
        return (
          <li key={i} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
            <div className="min-w-[9rem] flex-1">
              <p className="font-medium">{String(r["Client"] ?? "")}</p>
              <p className="text-xs text-muted-foreground">{String(r["Invoice"] ?? "").startsWith("Part ") ? String(r["Invoice"]) : `Invoice ${String(r["Invoice"] ?? "")}`}</p>
            </div>
            <p className="w-28 text-right font-medium tabular-nums">{money(r["Outstanding"], r["Currency"])}</p>
            <span className={`rounded-full px-2 py-0.5 text-xs ${late > 0 ? "bg-red-100 text-red-800" : "bg-muted text-muted-foreground"}`}>{late > 0 ? `${late} day${late === 1 ? "" : "s"} late` : "Not due yet"}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs ${REASON_TONE[reason] ?? "bg-muted text-muted-foreground"}`}>{reason}</span>
            <p className="basis-full text-xs text-muted-foreground">{String(r["Next action"] ?? "")}</p>
          </li>
        );
      })}
    </ul>
  );
}

const VERDICTS: { id: string; label: string; tone: string; hint: string }[] = [
  { id: "allow", label: "Within mandate", tone: "text-emerald-700", hint: "ran on its own" },
  { id: "needs_approval", label: "Needs approval", tone: "text-amber-700", hint: "waits for you" },
  { id: "deny", label: "Blocked", tone: "text-red-700", hint: "never ran" },
];

/** 2. Mandate decisions: "the LLM proposes, TypeScript decides" as data. Counts per verdict and the latest decisions with their reasons. */
function DecisionsWidget(params: Params) {
  const rows = useRows(params);
  if (!rows) return <Empty text="Loading…" />;
  if (!rows.length) return <Empty text="No agent proposals yet. Run Diagnose now on an invoice." />;
  const count = (v: string) => rows.filter((r) => r["Mandate verdict"] === v).length;
  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="grid grid-cols-3 gap-2 p-3">
        {VERDICTS.map((v) => (
          <div key={v.id} className="rounded-lg border p-3">
            <p className={`text-2xl font-semibold tabular-nums ${v.tone}`}>{count(v.id)}</p>
            <p className="text-xs font-medium">{v.label}</p>
            <p className="text-xs text-muted-foreground">{v.hint}</p>
          </div>
        ))}
      </div>
      <ul className="divide-y border-t">
        {[...rows].sort((a, b) => String(b["Date"]).localeCompare(String(a["Date"]))).slice(0, 8).map((r, i) => (
          <li key={i} className="px-4 py-2 text-sm">
            <p>
              <span className="font-medium">{String(r["Client"])}</span>: {String(r["Action"])}
              <span className="ml-2 text-xs text-muted-foreground">{String(r["Outcome"])}</span>
            </p>
            <p className="text-xs text-muted-foreground">{String(r["Reasons"])}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 3. Plan tracker: each payment plan with its instalments, paid ones filled in, and the strategy used. */
function PlansWidget(params: Params) {
  const rows = useRows(params);
  if (!rows) return <Empty text="Loading…" />;
  if (!rows.length) return <Empty text="No payment plans yet. Accept one from a client's pay page." />;
  const plans = new Map<string, Row[]>();
  for (const r of rows) plans.set(String(r["Plan"]), [...(plans.get(String(r["Plan"])) ?? []), r]);
  return (
    <ul className="divide-y overflow-auto" style={{ height: "100%" }}>
      {[...plans.values()].map((parts, i) => {
        const paid = parts.filter((p) => Number(p["Paid"]) === 1).length;
        return (
          <li key={i} className="space-y-2 px-4 py-3 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-medium">
                {String(parts[0]["Client"])} <span className="text-xs font-normal text-muted-foreground">{String(parts[0]["Strategy"])}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {paid} of {parts.length} paid
              </p>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={paid} aria-valuemax={parts.length}>
              <div className="h-full bg-emerald-600" style={{ width: `${(100 * paid) / parts.length}%` }} />
            </div>
            <ul className="grid gap-1 sm:grid-cols-2">
              {[...parts].sort((a, b) => String(a["Due"]).localeCompare(String(b["Due"]))).map((p, n) => (
                <li key={n} className={`rounded-md border px-2 py-1 text-xs ${Number(p["Paid"]) === 1 ? "bg-emerald-50 text-emerald-900" : ""}`}>
                  <span className="font-medium">{String(p["Part"])}</span> {money(p["Amount"], p["Currency"])} by {String(p["Due"])}
                  <span className="block text-muted-foreground">{String(p["Status"])}</span>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

const fieldset = (aiDescription: string) => ({ fields: { type: "fieldset" as const, supportedRoles: ["category", "numeric", "temporal"] as ("category" | "numeric" | "temporal")[], required: true, aiDescription } });

const common = {
  form: (p: { createDefaults: (o: { dataMappingItems: { key: string; label: string }[] }) => unknown }) => p.createDefaults({ dataMappingItems: [{ key: "fields", label: "Fields" }] }),
  minSize: { width: 6, height: 6 },
  toolbar: ["duplicate", "delete"] as ("duplicate" | "delete")[],
};

export const CUSTOM_WIDGETS = [
  {
    ...common,
    id: "owes",
    label: "Who still owes what",
    comp: OwesWidget,
    dataMapping: fieldset("Open-invoice fields: Client, Invoice, Currency, Outstanding, Days overdue, Diagnosed reason, Next action."),
    defaultSize: { width: 24, height: 14 },
    ai: { description: "One line per open invoice, most overdue first, with the diagnosed reason and the next action.", usage: "Use for questions about who owes money and what happens next. Map the Receivables fields." },
  },
  {
    ...common,
    id: "decisions",
    label: "Mandate decisions",
    comp: DecisionsWidget,
    dataMapping: fieldset("Decision fields: Client, Action, Mandate verdict, Outcome, Reasons, Date."),
    defaultSize: { width: 12, height: 30 },
    ai: { description: "Counts of agent proposals the mandate allowed, held for approval or blocked, plus the latest decisions with reasons.", usage: "Use to show how the agent's proposals were checked. Map the Mandate decisions fields." },
  },
  {
    ...common,
    id: "plans",
    label: "Plan tracker",
    comp: PlansWidget,
    dataMapping: fieldset("Plan instalment fields: Client, Plan, Strategy, Part, Amount, Currency, Due, Status, Paid."),
    defaultSize: { width: 12, height: 30 },
    ai: { description: "Each payment plan with its instalments and a progress bar of the paid ones.", usage: "Use to track plans in progress. Map the Payment plans fields." },
  },
] as unknown as AgWidgetDefinition[];
