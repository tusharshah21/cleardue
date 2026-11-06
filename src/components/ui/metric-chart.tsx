"use client";

// The chart behind ProgressMetricCard: a smooth curve or bars, one or several series, hover to read a point.
// Drawn as plain SVG (no chart library) in a 100x100 box that stretches to its container.
import { useId, useState } from "react";

export interface SeriesPoint {
  value: number;
  date: string;
}
export type MetricAccent = "emerald" | "rose" | "sky" | "amber" | "violet" | "neutral";
export type ChartView = "curve" | "bars";
export interface MetricSeries {
  name: string;
  data: SeriesPoint[];
  accent?: MetricAccent;
}
export interface ChartSeries {
  name: string;
  data: SeriesPoint[];
  color: string;
}

/** stroke = chart line and glow; text = readable text colour on the card background. */
export const ACCENTS: Record<MetricAccent, { stroke: string; text: string }> = {
  emerald: { stroke: "#10b981", text: "#047857" },
  rose: { stroke: "#f43f5e", text: "#be123c" },
  sky: { stroke: "#1f3fff", text: "#1f3fff" },
  amber: { stroke: "#f59e0b", text: "#b45309" },
  violet: { stroke: "#8b5cf6", text: "#6d28d9" },
  neutral: { stroke: "#737373", text: "#525252" },
};
export const SERIES_COLORS = ["#1f3fff", "#10b981", "#f59e0b", "#f43f5e", "#8b5cf6"];

export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  if (abs >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

const PAD_TOP = 40; // keep the line well below the card's headline
const PAD_BOTTOM = 8;

/** Smooth path through the points (Catmull-Rom turned into cubic Béziers). */
function smooth(pts: [number, number][]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

export function MetricChart({
  series,
  view,
  defaultIndex,
  valueFormatter,
  dateFormatter,
}: {
  series: ChartSeries[];
  view: ChartView;
  defaultIndex: number;
  valueFormatter: (n: number) => string;
  dateFormatter: (d: string) => string;
}) {
  const uid = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const n = series[0]?.data.length ?? 0;
  if (n < 2) return null;

  const all = series.flatMap((s) => s.data.map((p) => p.value));
  const min = view === "bars" ? Math.min(0, ...all) : Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const x = (i: number) => 4 + (i / (n - 1)) * 92;
  const y = (v: number) => PAD_TOP + (1 - (v - min) / span) * (100 - PAD_TOP - PAD_BOTTOM);
  const active = Math.min(Math.max(hover ?? defaultIndex, 0), n - 1);
  const primary = series[0];
  const barW = (92 / (n - 1)) * 0.55;

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const pct = ((e.clientX - r.left) / r.width) * 100;
    setHover(Math.round(Math.min(Math.max(((pct - 4) / 92) * (n - 1), 0), n - 1)));
  };

  const tipLeft = Math.min(Math.max(x(active), 24), 78);

  return (
    <div className="absolute inset-0" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={`${primary.name} chart`}>
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id={`${uid}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={primary.color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={primary.color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {view === "curve"
          ? series.map((s, i) => {
              const pts = s.data.map((p, k) => [x(k), y(p.value)] as [number, number]);
              const line = smooth(pts);
              return (
                <g key={s.name}>
                  {i === 0 && <path d={`${line} L ${pts[pts.length - 1][0]} 100 L ${pts[0][0]} 100 Z`} fill={`url(#${uid}-fill)`} />}
                  <path d={line} fill="none" stroke={s.color} strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" opacity={i === 0 ? 1 : 0.85} />
                </g>
              );
            })
          : series.map((s, i) => {
              const w = barW / series.length;
              return s.data.map((p, k) => {
                const top = y(p.value);
                const base = y(Math.max(min, 0));
                return <rect key={`${s.name}-${k}`} x={x(k) - barW / 2 + i * w} y={Math.min(top, base)} width={w * 0.9} height={Math.max(Math.abs(base - top), 0.8)} rx={0.8} fill={s.color} opacity={k === active ? 1 : 0.38} />;
              });
            })}
        <line x1={x(active)} x2={x(active)} y1={PAD_TOP - 6} y2={100} stroke={primary.color} strokeOpacity={0.35} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" strokeWidth={1} />
      </svg>

      {/* The active point, as a dot per series (HTML so it stays round while the SVG stretches). */}
      {view === "curve" &&
        series.map((s) => (
          <span key={s.name} className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card shadow" style={{ left: `${x(active)}%`, top: `${y(s.data[active].value)}%`, background: s.color }} />
        ))}

      <div className="pointer-events-none absolute z-20 -translate-x-1/2 rounded-xl border border-border bg-popover px-3 py-2 text-xs shadow-md" style={{ left: `${tipLeft}%`, bottom: "24%" }}>
        <p className="whitespace-nowrap text-muted-foreground">{dateFormatter(primary.data[active].date)}</p>
        {series.map((s) => (
          <p key={s.name} className="mt-0.5 flex items-center gap-1.5 font-medium whitespace-nowrap text-popover-foreground">
            <span className="size-2 rounded-full" style={{ background: s.color }} />
            {series.length > 1 && <span className="font-normal text-muted-foreground">{s.name}</span>}
            {valueFormatter(s.data[active].value)}
          </p>
        ))}
      </div>
    </div>
  );
}
