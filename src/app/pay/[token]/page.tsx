import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadPayInvoice } from "@/agent/payer";
import { StatusBadge } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableRow } from "@/components/ui/table";
import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { daysOverdue, isOpen } from "@/lib/receivables";
import { pendingAcceptance, planOptions } from "@/plans/accept";
import { strategyFor } from "@/plans/plans";
import type { LineItem } from "@/paypal/invoices";
import { PayChat, type ChatEntry } from "./pay-chat";
import { AutoRefresh, PlanOption } from "./plan-options";

export const metadata: Metadata = { title: "Invoice", robots: { index: false } };

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const isPaid = (status: string) => status === "PAID" || status === "MARKED_AS_PAID";

// Public page for the client. The unguessable pay token in the URL is the only credential.
export default async function PayPage({ params }: PageProps<"/pay/[token]">) {
  const { token } = await params;
  const invoice = await loadPayInvoice(token);
  if (!invoice) notFound();
  const { client } = invoice;
  const items = invoice.items as unknown as LineItem[];
  const outstanding = invoice.totalMinor - invoice.paidMinor;
  const open = isOpen(invoice);
  const plan = await db.planGroup.findUnique({ where: { originalInvoiceId: invoice.id }, include: { invoices: { orderBy: { dueDate: "asc" } } } });
  const awaiting = open && !plan?.invoices.length ? await pendingAcceptance(invoice.id) : null;
  const options = open && !plan?.invoices.length && !awaiting ? await planOptions(invoice) : [];
  const history: ChatEntry[] = invoice.payerQuestions.map((q) => ({
    question: q.question,
    answer: q.answer,
    citations: q.citations as ChatEntry["citations"],
    escalated: q.escalated,
    replayed: q.replayed,
    cached: q.cached,
    provider: q.provider ?? undefined,
  }));

  return (
    <main className="mx-auto w-full max-w-2xl space-y-6 p-4 py-10">
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">{client.freelancer.businessName}</p>
        <h1 className="text-2xl font-semibold">
          Invoice {invoice.invoiceNumber ?? ""} for {client.name}
        </h1>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardDescription>{open ? "Amount due" : "Total"}</CardDescription>
              <CardTitle className="text-3xl tabular-nums">{formatMoney(open ? outstanding : invoice.totalMinor, invoice.currency)}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">Due {ymd(invoice.dueDate)}</p>
            </div>
            <StatusBadge status={invoice.status} overdueDays={daysOverdue(invoice)} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Table>
            <TableBody>
              {items.map((i, n) => (
                <TableRow key={n}>
                  {/* Quantity sits under the name, so two columns fit a 375px phone. */}
                  <TableCell className="whitespace-normal">
                    <p className="font-medium">{i.name}</p>
                    {i.description && <p className="text-xs text-muted-foreground">{i.description}</p>}
                    {(i.unit === "HOURS" || i.quantity !== 1) && (
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {i.unit === "HOURS" ? `${i.quantity} h × ${formatMoney(i.unitAmountMinor, invoice.currency)}` : `× ${i.quantity}`}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-right align-top tabular-nums">{formatMoney(Math.round(i.quantity * i.unitAmountMinor), invoice.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>Total</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(invoice.totalMinor, invoice.currency)}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>

          {invoice.status === "PAID" || invoice.status === "MARKED_AS_PAID" ? (
            <p className="rounded-lg bg-muted p-3 text-sm">Paid. Thank you!</p>
          ) : plan?.invoices.length ? (
            <p className="rounded-lg bg-muted p-3 text-sm">This invoice was replaced by the payment plan below.</p>
          ) : open && invoice.payerViewUrl ? (
            <a href={invoice.payerViewUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: "lg", className: "w-full" })}>
              Pay with PayPal
            </a>
          ) : open ? (
            <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">The PayPal payment link isn&apos;t ready yet. Check the invoice email from PayPal, or ask below.</p>
          ) : (
            <p className="rounded-lg bg-muted p-3 text-sm">This invoice is {invoice.status.replaceAll("_", " ").toLowerCase()}.</p>
          )}
        </CardContent>
      </Card>

      {plan && plan.invoices.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Your payment plan</CardTitle>
            <CardDescription>
              {plan.invoices.filter((p) => isPaid(p.status)).length} of {plan.invoices.length} parts paid.{" "}
              {plan.state === "pending_send" ? "Some invoices are still being sent." : "Each part is its own PayPal invoice; pay them here whenever each is due."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {plan.invoices.map((p, n) => (
              <div key={p.id} className="space-y-2 rounded-lg border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    Part {n + 1} of {plan.invoices.length}: {formatMoney(p.totalMinor, p.currency)}
                  </span>
                  <StatusBadge status={p.status} overdueDays={isOpen(p) ? daysOverdue(p) : 0} />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted-foreground">{isPaid(p.status) ? "Paid, thank you." : `Due ${ymd(p.dueDate)}`}</span>
                  {isPaid(p.status) ? null : isOpen(p) && p.payerViewUrl ? (
                    <a href={p.payerViewUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: "sm" })}>
                      Pay with PayPal
                    </a>
                  ) : isOpen(p) ? (
                    <span className="text-xs text-muted-foreground">Being sent, ready in a moment</span>
                  ) : null}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {awaiting && (
        <Card>
          <CardHeader>
            <CardTitle>Your payment plan</CardTitle>
            <CardDescription>{client.freelancer.name.split(" ")[0]} will confirm your plan shortly. This page updates when it&apos;s ready.</CardDescription>
          </CardHeader>
          <AutoRefresh />
        </Card>
      )}

      {options.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Prefer to pay in parts?</CardTitle>
            <CardDescription>
              These options are within {client.freelancer.name}&apos;s payment terms. Accepting replaces this invoice with{" "}
              {strategyFor(client.freelancer.country) === "split_invoices" ? "one PayPal invoice per part." : "one PayPal invoice you can pay in parts."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {options.map((o, n) => (
              <PlanOption key={n} token={token} index={n} label={o.map((p) => `${formatMoney(p.amountMinor, invoice.currency)} by ${ymd(p.dueDate)}`).join(", then ")} />
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Questions about this invoice?</CardTitle>
          <CardDescription>
            Answers come only from the agreed scope, this invoice and your messages, with quotes. Anything else goes to {client.freelancer.name}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PayChat token={token} history={history} suggestions={items.slice(0, 3).map((i) => `What does '${i.name}' cover?`)} freelancerName={client.freelancer.name} />
        </CardContent>
      </Card>
    </main>
  );
}
