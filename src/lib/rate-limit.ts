// Sliding-window rate limit kept in process memory.
// ponytail: per-instance memory, fine for one Render instance; move to Postgres or Redis if we scale out.
const hits = new Map<string, number[]>();

/** Records a hit for `key` and returns false once it has `limit` hits inside `windowMs`. */
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => t > now - windowMs);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) hits.clear(); // bound memory under abuse
  return true;
}
