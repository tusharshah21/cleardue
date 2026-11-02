import { Badge } from "@/components/ui/badge";

export function StatusBadge({ status, overdueDays = 0 }: { status: string; overdueDays?: number }) {
  if (overdueDays > 0) return <Badge variant="destructive">Overdue {overdueDays}d</Badge>;
  const variant = status === "PAID" || status === "MARKED_AS_PAID" ? "default" : status === "DRAFT" ? "outline" : "secondary";
  return <Badge variant={variant}>{status.replaceAll("_", " ").toLowerCase()}</Badge>;
}
