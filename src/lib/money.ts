// Integer minor-unit money helpers. Never do money maths in floats.

// PayPal currencies with no minor unit.
const ZERO_DECIMAL = new Set(["JPY", "HUF", "TWD"]);

export function decimals(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/** "123.45" -> 12345. Throws on malformed input or too many decimals. */
export function toMinor(value: string, currency: string): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`Invalid amount "${value}"`);
  const d = decimals(currency);
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > d) throw new Error(`Amount "${value}" has more than ${d} decimals for ${currency}`);
  return Number(m[1]) * 10 ** d + Number(frac.padEnd(d, "0") || "0");
}

/** 12345 -> "123.45" (the string format PayPal expects). */
export function fromMinor(minor: number, currency: string): string {
  if (!Number.isInteger(minor) || minor < 0) throw new Error(`Invalid minor amount ${minor}`);
  const d = decimals(currency);
  if (d === 0) return String(minor);
  return `${Math.floor(minor / 10 ** d)}.${String(minor % 10 ** d).padStart(d, "0")}`;
}

/** Splits an amount into n whole minor-unit parts that sum exactly; the first part takes the remainder. */
export function splitEvenly(totalMinor: number, n: number): number[] {
  if (!Number.isInteger(totalMinor) || totalMinor < 0 || !Number.isInteger(n) || n < 1) throw new Error("Invalid split");
  const base = Math.floor(totalMinor / n);
  return Array.from({ length: n }, (_, i) => (i === 0 ? base + (totalMinor - base * n) : base));
}

export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 10 ** decimals(currency));
}
