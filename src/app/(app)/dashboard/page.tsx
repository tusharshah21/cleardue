import Link from "next/link";
import { after } from "next/server";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireFreelancer } from "@/lib/auth";
import { db } from "@/lib/db";
import { syncStale } from "@/lib/invoicing";
import { formatMoney } from "@/lib/money";
import { describeProposal, REASON_LABELS } from "@/lib/proposals";
import { daysOverdue, isOpen, outstanding, sumByCurrency } from "@/lib/receivables";
import { retryPendingPlans } from "@/plans/accept";
import { ReceivablesGrid, type ReceivableRow } from "./receivables-grid";

export default async function DashboardPage() {
  const freelancer = await requireFreelancer();
  // Webhooks can be late or missing; refresh stale invoices after this response is sent.
  after(() =>
    syncStale()
      .then(retryPendingPlans)
      .catch((e) => console.error("background sync failed", e)),
  );
  const invoices = await db.invoice.findMany({
    where: { client: { freelancerId: freelancer.id } },
    include: { client: true, case: { include: { actions: { where: { status: "pending" }, orderBy: { createdAt: "asc" }, take: 1 } } }, tasks: { where: { done: false }, take: 1 } },
    orderBy: { dueDate: "asc" },
  });
  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 86_400_000);
  const open = invoices.filter(isOpen);
  const overdue = open.filter((i) => daysOverdue(i, now) > 0);
  const dueThisWeek = open.filter((i) => i.dueDate >= now && i.dueDate <= weekAhead);

  const rows: ReceivableRow[] = invoices.map((i) => {
    const pending = i.case?.actions[0];
    const overdue = daysOverdue(i, now);
    const nextAction = i.tasks.length
      ? "Reply to the client's pay-page message"
      : pending
        ? `Approve: ${describeProposal(pending.type, pending.params as Record<string, unknown>).title}`
        : i.status === "DRAFT"
          ? "Send the draft"
          : !isOpen(i)
            ? ""
            : i.case?.state === "dispute"
              ? "Resolve the dispute yourself"
              : i.case?.state === "paused"
                ? `Paused until ${i.case.pausedUntil?.toISOString().slice(0, 10) ?? "later"}`
                : overdue > 0
                  ? "Diagnose"
                  : "Wait for the due date";
    const owed = i.status === "DRAFT" ? i.totalMinor : outstanding(i);
    return {
      id: i.id,
      client: i.client.name,
      invoice: i.invoiceNumber ?? (i.status === "DRAFT" ? "Draft" : "Local only"),
      status: overdue > 0 ? "OVERDUE" : i.status,
      dueDate: i.dueDate.toISOString().slice(0, 10),
      daysOverdue: overdue,
      outstanding: owed,
      outstandingText: formatMoney(owed, i.currency),
      reason: i.case?.reason ? (REASON_LABELS[i.case.reason] ?? i.case.reason) : "",
      nextAction,
    };
  });

  const stats = [
    { label: "Total owed", value: sumByCurrency(open), hint: `${open.length} open invoices` },
    { label: "Overdue", value: sumByCurrency(overdue), hint: `${overdue.length} invoices past due` },
    { label: "Expected this week", value: sumByCurrency(dueThisWeek), hint: `${dueThisWeek.length} due in 7 days` },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Receivables</h1>
        <Link href="/invoices/new" className={buttonVariants()}>
          New invoice
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader>
              <CardDescription>{s.label}</CardDescription>
              <CardTitle className="text-xl">{s.value}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">{s.hint}</CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No invoices yet. <Link href="/clients" className="underline">Add a client</Link>, then create one.
            </p>
          ) : (
            <ReceivablesGrid rows={rows} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
