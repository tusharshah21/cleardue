// When the scheduled jobs last ran. /api/sync (the cron) and the daily demo reset record themselves here, and
// /api/health/db and Start here read it back, so a cron that isn't running shows up instead of failing silently.
import { db } from "./db";

export type StateKey = "lastScheduledSyncAt" | "lastDailyResetAt";

export const markNow = (key: StateKey, at = new Date()) => db.appState.upsert({ where: { key }, create: { key, at }, update: { at } });

export async function readTimes(): Promise<Record<StateKey, Date | null>> {
  const rows = await db.appState.findMany();
  const at = (key: StateKey) => rows.find((r) => r.key === key)?.at ?? null;
  return { lastScheduledSyncAt: at("lastScheduledSyncAt"), lastDailyResetAt: at("lastDailyResetAt") };
}

/** "3 min ago", "2 h ago", or "never" for a time that hasn't happened. */
export function ago(at: Date | null, now = new Date()): string {
  if (!at) return "never";
  const min = Math.max(0, Math.round((now.getTime() - at.getTime()) / 60_000));
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
}
