import { describe, expect, it } from "vitest";
import { dueAheadSeries, netChange, openCountSeries, overdueCountSeries } from "./dashboard-series";

const NOW = new Date("2026-11-10T15:00:00Z");
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const inv = (status: string, issue: string, due: string, updated = "2026-11-10") => ({ status, issueDate: d(issue), dueDate: d(due), updatedAt: d(updated) });

describe("dashboard series", () => {
  it("counts open invoices day by day, and drops one the day after it was paid", () => {
    const list = [inv("SENT", "2026-11-01", "2026-11-20"), inv("PAID", "2026-11-02", "2026-11-12", "2026-11-06")];
    const s = openCountSeries(list, NOW, 10); // 1 Nov .. 10 Nov
    expect(s).toHaveLength(10);
    expect(s.map((p) => p.value)).toEqual([1, 2, 2, 2, 2, 1, 1, 1, 1, 1]);
  });

  it("an invoice cannot be open before it is issued, nor issued after it is due", () => {
    const seeded = inv("SENT", "2026-11-10", "2026-10-28"); // seeded "today" but due weeks ago
    const s = openCountSeries([seeded], NOW, 20); // 22 Oct .. 10 Nov
    expect(s[0].value).toBe(0);
    expect(s.at(-1)?.value).toBe(1);
    expect(s.find((p) => p.date === "28 Oct")?.value).toBe(1);
  });

  it("counts overdue invoices from the day after they fall due", () => {
    const s = overdueCountSeries([inv("SENT", "2026-10-01", "2026-11-05")], NOW, 8); // 3 Nov .. 10 Nov
    expect(s.map((p) => p.value)).toEqual([0, 0, 0, 1, 1, 1, 1, 1]);
  });

  it("lists what falls due in the next days, today first, open invoices only", () => {
    const list = [inv("SENT", "2026-11-01", "2026-11-12"), inv("SENT", "2026-11-01", "2026-11-12"), inv("PAID", "2026-11-01", "2026-11-11", "2026-11-09"), inv("SENT", "2026-11-01", "2026-11-30")];
    const s = dueAheadSeries(list, NOW, 5);
    expect(s.map((p) => p.date)).toEqual(["10 Nov", "11 Nov", "12 Nov", "13 Nov", "14 Nov"]);
    expect(s.map((p) => p.value)).toEqual([0, 0, 2, 0, 0]);
  });

  it("summarises the change between the first and last point", () => {
    expect(netChange([{ date: "a", value: 1 }, { date: "b", value: 4 }])).toEqual({ text: "+3", trend: "up" });
    expect(netChange([{ date: "a", value: 4 }, { date: "b", value: 1 }])).toEqual({ text: "−3", trend: "down" });
    expect(netChange([{ date: "a", value: 2 }, { date: "b", value: 2 }])).toEqual({ text: "0", trend: "flat" });
    expect(netChange([])).toEqual({ text: "0", trend: "flat" });
  });
});

describe("median", () => {
  it("takes the middle value, averages the middle pair, and ignores nulls", async () => {
    const { median } = await import("./utils");
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, null, 2, 3])).toBe(2.5);
    expect(median([null, undefined, "x"])).toBeNull();
  });
});
