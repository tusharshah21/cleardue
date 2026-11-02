import { createHash, timingSafeEqual } from "node:crypto";
import { syncStale } from "@/lib/invoicing";
import { retryPendingPlans } from "@/plans/accept";

// Polling fallback, called every few minutes by the Render cron job (see render.yaml).
const digest = (s: string) => createHash("sha256").update(s).digest();

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || !timingSafeEqual(digest(given), digest(secret))) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json({ ...(await syncStale()), plansRetried: await retryPendingPlans() });
}
