import { requireFreelancer } from "@/lib/auth";
import { db } from "@/lib/db";
import { fromMinor } from "@/lib/money";
import { REASON_LABELS } from "@/lib/proposals";
import { daysOverdue, isOpen } from "@/lib/receivables";

// SPIKE (spike/ag-studio): the ClearDue endpoint the AG Studio analyst's custom tool calls. Open invoices only.
export async function GET() {
  const freelancer = await requireFreelancer();
  const invoices = await db.invoice.findMany({ where: { client: { freelancerId: freelancer.id } }, include: { client: true, case: true } });
  const rows = invoices.filter(isOpen).map((i) => ({
    client: i.client.name,
    invoice: i.invoiceNumber ?? i.id.slice(-6),
    currency: i.currency,
    outstanding: Number(fromMinor(i.totalMinor - i.paidMinor, i.currency)),
    daysOverdue: daysOverdue(i),
    reason: i.case?.reason ? (REASON_LABELS[i.case.reason] ?? i.case.reason) : "Not diagnosed",
  }));
  return Response.json(rows);
}
