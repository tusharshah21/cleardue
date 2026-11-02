import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireFreelancer } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { daysOverdue, isOpen, sumByCurrency } from "@/lib/receivables";

export default async function DashboardPage() {
  const freelancer = await requireFreelancer();
  const invoices = await db.invoice.findMany({
    where: { client: { freelancerId: freelancer.id } },
    include: { client: true },
    orderBy: { dueDate: "asc" },
  });
  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 86_400_000);
  const open = invoices.filter(isOpen);
  const overdue = open.filter((i) => daysOverdue(i, now) > 0);
  const dueThisWeek = open.filter((i) => i.dueDate >= now && i.dueDate <= weekAhead);

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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      <Link href={`/invoices/${i.id}`} className="font-medium hover:underline">
                        {i.client.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{i.invoiceNumber ?? "Local only"}</TableCell>
                    <TableCell>{i.dueDate.toISOString().slice(0, 10)}</TableCell>
                    <TableCell>
                      <StatusBadge status={i.status} overdueDays={daysOverdue(i, now)} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(i.totalMinor, i.currency)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
