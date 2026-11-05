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

// A bracketed stand-in such as "[Your name]", "[link]" or "[Pay invoice 0159]" left in a message meant to be sent as it is.
const PLACEHOLDER = /\[[^\]\r\n]{1,60}\]/;

/** True when any string inside `value` contains a bracketed placeholder. */
export function hasPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return PLACEHOLDER.test(value);
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (value && typeof value === "object") return Object.values(value).some(hasPlaceholder);
  return false;
}

/** Text that must be rewritten before anyone sees it: another script, or a placeholder left in. */
export const needsRewrite = (value: unknown) => hasForeignScript(value) || hasPlaceholder(value);

export interface SafeContext {
  freelancerName?: string;
  payLink?: string;
  invoiceNumber?: string | null;
}

/** The plain message used when two tries still contain a placeholder or another script: real name, real pay link. */
export function templateMessage(ctx: SafeContext = {}): string {
  const invoice = ctx.invoiceNumber ? `invoice ${ctx.invoiceNumber}` : "your invoice";
  return `Hi, a quick note about ${invoice}.${ctx.payLink ? ` You can pay or ask questions here: ${ctx.payLink}.` : ""} Thanks!${ctx.freelancerName ? ` ${ctx.freelancerName}` : ""}`;
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
