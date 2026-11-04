import { readTimes } from "@/lib/app-state";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// Health with the database and the scheduled jobs: when the cron last synced and when the daily demo reset last ran.
// Timestamps only, no data. A null lastScheduledSyncAt long after a deploy means the cron job isn't running.
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    const t = await readTimes();
    return Response.json({ ok: true, db: true, lastScheduledSyncAt: t.lastScheduledSyncAt?.toISOString() ?? null, lastDailyResetAt: t.lastDailyResetAt?.toISOString() ?? null });
  } catch {
    return Response.json({ ok: false, db: false, error: "database unreachable" }, { status: 503 });
  }
}
