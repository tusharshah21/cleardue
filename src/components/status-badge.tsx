import { Badge } from "@/components/ui/badge";

// PayPal's invoice statuses, as a person would say them.
const LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SCHEDULED: "Scheduled",
  SENT: "Sent, awaiting payment",
  UNPAID: "Unpaid",
  PAYMENT_PENDING: "Payment processing",
  PARTIALLY_PAID: "Partly paid",
  PAID: "Paid",
  MARKED_AS_PAID: "Paid (recorded)",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
  PARTIALLY_REFUNDED: "Partly refunded",
  MARKED_AS_REFUNDED: "Refunded (recorded)",
};

export function invoiceStatusLabel(status: string, overdueDays = 0) {
  if (overdueDays > 0) return `Overdue ${overdueDays} day${overdueDays === 1 ? "" : "s"}`;
  return LABELS[status] ?? status.replaceAll("_", " ").toLowerCase();
}

export function StatusBadge({ status, overdueDays = 0 }: { status: string; overdueDays?: number }) {
  const variant =
    overdueDays > 0 ? "destructive" : status === "PAID" || status === "MARKED_AS_PAID" ? "default" : status === "DRAFT" || status === "CANCELLED" ? "outline" : "secondary";
  return <Badge variant={variant}>{invoiceStatusLabel(status, overdueDays)}</Badge>;
}
