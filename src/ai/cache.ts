// Response cache: the first live result of an AI call is stored and reused for identical inputs, so a shared demo
// account stays inside the model's quota without faking anything (a reused result is labelled as cached).
// Only the demo freelancer has one. Replayed (DEMO_MODE) and fallback results are never stored.
import { createHash } from "node:crypto";
import type { LanguageModel } from "ai";
import { db } from "@/lib/db";
import { hasForeignScript } from "@/lib/script-guard";

export interface CacheScope {
  freelancerId: string;
  /** Fingerprint of the demo stories; an entry made under other stories is stale and never matches. */
  seed: string;
}

/** The cache scope for this freelancer: set for the demo account only, null for everyone else (and in DEMO_MODE, which replays recordings instead). */
export async function cacheScopeFor(freelancer: { id: string; email: string } | null | undefined): Promise<CacheScope | null> {
  if (!freelancer || process.env.DEMO_MODE === "true") return null;
  const { demoEmail, seedFingerprint } = await import("@/lib/demo-seed"); // lazy: demo-seed pulls in the PayPal client
  return freelancer.email.toLowerCase() === demoEmail() ? { freelancerId: freelancer.id, seed: seedFingerprint() } : null;
}

export interface CacheRequest {
  scope: CacheScope | null | undefined;
  task: string;
  /** Every input that can change the answer, and nothing volatile (ids, timestamps) that can't. */
  parts: unknown[];
}

/** Bump to retire every cached result at once (older rows stay in the table but never match again). Used when the cache
 * must not be reused, for example before a recording that should show live answers. `npm run cache:clear` also deletes rows. */
export const CACHE_EPOCH = "2026-11-05-capture-5";

const modelName = (m: LanguageModel) => (typeof m === "string" ? m : `${m.provider}/${m.modelId}`);

export const cacheKey = (model: LanguageModel, req: CacheRequest) =>
  createHash("sha256").update(JSON.stringify([CACHE_EPOCH, modelName(model), req.scope?.seed, req.task, req.parts])).digest("hex");

export async function readCache(model: LanguageModel, req: CacheRequest): Promise<unknown | undefined> {
  if (!req.scope) return undefined;
  try {
    const row = await db.aiCache.findUnique({ where: { freelancerId_key: { freelancerId: req.scope.freelancerId, key: cacheKey(model, req) } } });
    if (row && hasForeignScript(row.output)) return undefined; // an entry written before the guard existed
    return row?.output ?? undefined;
  } catch {
    return undefined; // a cache problem must never break the call itself
  }
}

export async function writeCache(model: LanguageModel, req: CacheRequest, output: unknown) {
  if (!req.scope || hasForeignScript(output)) return;
  const key = cacheKey(model, req);
  try {
    await db.aiCache.upsert({
      where: { freelancerId_key: { freelancerId: req.scope.freelancerId, key } },
      create: { freelancerId: req.scope.freelancerId, key, seed: req.scope.seed, task: req.task, model: modelName(model), output: output as object },
      update: {},
    });
  } catch {
    // ignored: the result is still returned, just not stored
  }
}

/** Maintenance: delete cached AI results that contain non-Latin letters (always) and, with `all`, every cached result.
 * Returns how many rows were removed. */
export async function clearAiCache(opts: { all?: boolean } = {}): Promise<{ removed: number; foreign: number }> {
  const rows = await db.aiCache.findMany({ select: { id: true, output: true } });
  const foreign = rows.filter((r) => hasForeignScript(r.output)).map((r) => r.id);
  if (opts.all) {
    const res = await db.aiCache.deleteMany({});
    return { removed: res.count, foreign: foreign.length };
  }
  if (!foreign.length) return { removed: 0, foreign: 0 };
  const res = await db.aiCache.deleteMany({ where: { id: { in: foreign } } });
  return { removed: res.count, foreign: foreign.length };
}
