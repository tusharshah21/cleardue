import { formatMoney } from "./money";

// PayPal statuses where money is still owed.
export const OPEN_STATUSES = ["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED", "PAYMENT_PENDING"];

interface Owed {
  status: string;
  dueDate: Date;
  totalMinor: number;
  paidMinor: number;
  currency: string;
}

export const isOpen = (i: Owed) => OPEN_STATUSES.includes(i.status);
export const daysOverdue = (i: Owed, now = new Date()) =>
  isOpen(i) ? Math.max(0, Math.floor((now.getTime() - i.dueDate.getTime()) / 86_400_000)) : 0;
export const outstanding = (i: Owed) => (isOpen(i) ? i.totalMinor - i.paidMinor : 0);

/** Clients bill in different currencies, so totals stay per currency: "$2,400.00 · £1,800.00". */
export function sumByCurrency(invoices: Owed[]): string {
  const sums = new Map<string, number>();
  for (const i of invoices) sums.set(i.currency, (sums.get(i.currency) ?? 0) + outstanding(i));
  const parts = [...sums].filter(([, v]) => v > 0).map(([c, v]) => formatMoney(v, c));
  return parts.length ? parts.join(" · ") : "Nothing owed";
}
