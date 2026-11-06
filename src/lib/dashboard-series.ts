// Daily series for the dashboard's metric cards, worked out from the invoices themselves (counts, so mixed currencies
// never get added together). An invoice counts as open from its issue date (never later than its due date, since an
// invoice can't be issued after it is due) until it stops being open; for closed ones that moment is their last update.
import { isOpen } from "./receivables";

export interface SeriesInvoice {
  status: string;
  issueDate: Date;
  dueDate: Date;
  updatedAt: Date;
}
export interface DayPoint {
  value: number;
  date: string;
}

const DAY = 86_400_000;
const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const label = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** Was the invoice open (money still owed) at the end of this day? */
export function openOn(i: SeriesInvoice, dayMs: number): boolean {
  const end = dayMs + DAY - 1;
  const start = Math.min(i.issueDate.getTime(), i.dueDate.getTime());
  if (start > end) return false;
  if (isOpen({ status: i.status, dueDate: i.dueDate, totalMinor: 0, paidMinor: 0, currency: "" })) return true;
  return i.updatedAt.getTime() > end;
}

const days = (from: number, count: number) => Array.from({ length: count }, (_, k) => from + k * DAY);

/** Number of open invoices at the end of each of the `count` days up to and including `now`. */
export function openCountSeries(invoices: SeriesInvoice[], now: Date, count = 30): DayPoint[] {
  return days(startOfDay(now) - (count - 1) * DAY, count).map((d) => ({ date: label(d), value: invoices.filter((i) => openOn(i, d)).length }));
}

/** Number of open invoices already past their due date at the end of each day. */
export function overdueCountSeries(invoices: SeriesInvoice[], now: Date, count = 30): DayPoint[] {
  return days(startOfDay(now) - (count - 1) * DAY, count).map((d) => ({ date: label(d), value: invoices.filter((i) => openOn(i, d) && startOfDay(i.dueDate) < d).length }));
}

/** Open invoices falling due on each of the next days (today first). */
export function dueAheadSeries(invoices: SeriesInvoice[], now: Date, count = 8): DayPoint[] {
  const open = invoices.filter((i) => isOpen({ status: i.status, dueDate: i.dueDate, totalMinor: 0, paidMinor: 0, currency: "" }));
  return days(startOfDay(now), count).map((d) => ({ date: label(d), value: open.filter((i) => startOfDay(i.dueDate) === d).length }));
}

/** "+2", "-1" or "0": the change from the first to the last point. */
export function netChange(series: DayPoint[]): { text: string; trend: "up" | "down" | "flat" } {
  const net = (series.at(-1)?.value ?? 0) - (series[0]?.value ?? 0);
  return { text: net > 0 ? `+${net}` : net < 0 ? `−${Math.abs(net)}` : "0", trend: net > 0 ? "up" : net < 0 ? "down" : "flat" };
}
