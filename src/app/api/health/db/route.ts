import { readTimes } from "@/lib/app-state";
import { CACHE_EPOCH } from "@/ai/cache";
import { db } from "@/lib/db";
import { checkPayPalAuth } from "@/paypal/client";

export const dynamic = "force-dynamic";

// Health with the database and the scheduled jobs: when the cron last synced and when the daily demo reset last ran.
// Timestamps and the PayPal credential check, no data. A null lastScheduledSyncAt long after a deploy means the cron job isn't running.
export async function GET() {
  try {
    await db.$queryRaw`SELECT 1`;
    const t = await readTimes();
    // PayPal credential watch: a fresh token fetch, remembered for 5 minutes. A rejected secret shows here and on Start here.
    const paypal = await checkPayPalAuth();
    return Response.json({ ok: true, db: true, paypal, aiCacheEpoch: CACHE_EPOCH, lastScheduledSyncAt: t.lastScheduledSyncAt?.toISOString() ?? null, lastDailyResetAt: t.lastDailyResetAt?.toISOString() ?? null });
  } catch {
    return Response.json({ ok: false, db: false, error: "database unreachable" }, { status: 503 });
  }
}
