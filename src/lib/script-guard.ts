// Guard for AI-written text. The product writes English in Latin letters; a model that slips another script into a
// sentence ("I предложed a two-part payment plan") must never reach a freelancer, a client or the response cache.
// Accented Latin letters (é, ñ) are fine; Cyrillic, Greek, Arabic, CJK and the like are not.
const FOREIGN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

/** True when any string inside `value` (strings, arrays, plain objects) contains a letter outside the Latin script. */
export function hasForeignScript(value: unknown): boolean {
  if (typeof value === "string") return FOREIGN_LETTER.test(value);
  if (Array.isArray(value)) return value.some(hasForeignScript);
  if (value && typeof value === "object") return Object.values(value).some(hasForeignScript);
  return false;
}

/** Plain, neutral sentences used when a retry still produced a foreign script. */
export const TEMPLATE = {
  note: "I reviewed the client's reply and queued the next step for you.",
  subject: "Following up on your invoice",
  message: "Hi, just a quick note about the invoice. The payment link is on the invoice page, and I'm happy to talk through any questions. Thanks!",
  planMessage: "I can split this invoice into smaller payments. Please use the link to look at the plan options. Thanks!",
  pauseReason: "Paused while the client's payment is pending.",
  summary: "The client raised a concern that needs your attention.",
  analyst: "I couldn't write a clean answer to that. Please ask again.",
} as const;
