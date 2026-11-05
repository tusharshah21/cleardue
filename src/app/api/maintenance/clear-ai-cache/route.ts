import { createHash, timingSafeEqual } from "node:crypto";
import { clearAiCache } from "@/ai/cache";

// Maintenance: always removes cached AI results that contain non-Latin letters; with {"all": true} removes every cached
// result, so the next run of each story is answered live. Protected by CRON_SECRET like /api/sync. Run it with `npm run cache:clear`.
const digest = (s: string) => createHash("sha256").update(s).digest();

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || !timingSafeEqual(digest(given), digest(secret))) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { all?: boolean };
  return Response.json(await clearAiCache({ all: body.all === true }));
}
