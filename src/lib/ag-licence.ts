// Is the AG Studio licence key usable? AG keys carry their expiry as a base64-encoded epoch (milliseconds) in one of
// their segments. Read here on the server so /analyst can say plainly what is wrong before Studio shows a watermark.
// Never logs or returns the key itself.
export type AgLicence = { state: "ok"; expiry: string | null } | { state: "missing" } | { state: "expired"; expiry: string };

export function agLicence(key: string | undefined, now = new Date()): AgLicence {
  if (!key?.trim()) return { state: "missing" };
  for (const part of key.split(/[_[\]]/)) {
    if (!/^[A-Za-z0-9+/]{16,24}={0,2}$/.test(part)) continue;
    const text = Buffer.from(part, "base64").toString("utf8");
    if (!/^\d{12,14}$/.test(text)) continue;
    const expiry = new Date(Number(text));
    return expiry < now ? { state: "expired", expiry: expiry.toISOString().slice(0, 10) } : { state: "ok", expiry: expiry.toISOString().slice(0, 10) };
  }
  return { state: "ok", expiry: null }; // no readable date: let Studio judge it
}
