"use client";

// Small controls for ProgressMetricCard: a curve/bars toggle and a period picker. They sit on a layer that ignores the
// pointer (so the chart underneath can be hovered), so each one turns pointer events back on for itself.
import { useEffect, useRef, useState } from "react";
import { BarChart3, Check, ChevronDown, TrendingUp } from "lucide-react";
import type { ChartView } from "./metric-chart";

export interface PeriodOption {
  label: string;
  /** How many of the latest points to show; leave out for all of them. */
  points?: number;
}

export function ViewToggle({ value, onChange }: { value: ChartView; onChange: (v: ChartView) => void }) {
  const item = (v: ChartView, label: string, Icon: typeof TrendingUp) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={value === v}
      onClick={() => onChange(v)}
      className={`pointer-events-auto flex size-6 items-center justify-center rounded-full transition-colors ${value === v ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
    >
      <Icon className="size-3.5" />
    </button>
  );
  return (
    <div role="group" aria-label="Chart style" className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-border bg-card/80 p-0.5">
      {item("curve", "Line chart", TrendingUp)}
      {item("bars", "Bar chart", BarChart3)}
    </div>
  );
}

export function PeriodSelect({ value, options, onChange, accentText }: { value: string; options: PeriodOption[]; onChange: (o: PeriodOption) => void; accentText: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div ref={box} className="pointer-events-auto relative">
      <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-1 rounded-full px-2 py-1 text-[13px] font-medium hover:bg-muted" style={{ color: accentText }}>
        {value}
        <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <ul role="listbox" aria-label="Period" className="absolute right-0 z-30 mt-1 min-w-36 rounded-xl border border-border bg-popover p-1 text-sm shadow-lg">
          {options.map((o) => (
            <li key={o.label} role="option" aria-selected={o.label === value}>
              <button
                type="button"
                onClick={() => {
                  onChange(o);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left hover:bg-muted"
              >
                {o.label}
                {o.label === value && <Check className="size-3.5" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
