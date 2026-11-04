import { createHash, timingSafeEqual } from "node:crypto";
import { markNow } from "@/lib/app-state";
import { dailyDemoReset } from "@/lib/demo-seed";
import { syncStale } from "@/lib/invoicing";
import { retryPendingPlans } from "@/plans/accept";

// Polling fallback, called every few minutes by the Render cron job (see render.yaml). With DEMO_DAILY_RESET=true it
// also resets the demo stories daily at 03:00 UTC.
const digest = (s: string) => createHash("sha256").update(s).digest();

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || !timingSafeEqual(digest(given), digest(secret))) return Response.json({ error: "unauthorized" }, { status: 401 });
  await markNow("lastScheduledSyncAt");
  const demoReset = await dailyDemoReset();
  return Response.json({ demoReset, ...(await syncStale()), plansRetried: await retryPendingPlans() });
}
