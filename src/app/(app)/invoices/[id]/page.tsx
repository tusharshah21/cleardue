import { notFound } from "next/navigation";
import { ProposalCard } from "@/components/proposal-card";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireFreelancer } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatMoney } from "@/lib/money";
import { REASON_LABELS } from "@/lib/proposals";
import { daysOverdue, isOpen } from "@/lib/receivables";
import type { LineItem } from "@/paypal/invoices";
import { ACME_EXTRA } from "@/ai/demo-fixtures";
import { isDemoMode } from "@/ai/provider";
import { ReplayedBadge } from "@/components/replayed-badge";
import { SimulatePaymentButton } from "@/components/simulate-payment-button";
import { isMockMode } from "@/paypal/client";
import { DiagnosePanel } from "./case-controls";
import { ScopeCheck, SendDraftButton } from "./scope-check";
import { SyncButton } from "./sync-button";

export default async function InvoicePage({ params }: PageProps<"/invoices/[id]">) {
  const { id } = await params;
  const freelancer = await requireFreelancer();
  const invoice = await db.invoice.findFirst({
    where: { id, client: { freelancerId: freelancer.id } },
    include: {
      client: true,
      project: true,
      messages: { orderBy: { sentAt: "asc" } },
      timeline: { orderBy: { createdAt: "desc" } },
      case: { include: { actions: { orderBy: { createdAt: "desc" }, take: 12 } } },
    },
  });
  if (!invoice) notFound();
  const kase = invoice.case;
  const evidence = (kase?.evidence as string[] | null) ?? [];
  const open = isOpen(invoice);
  const items = invoice.items as unknown as LineItem[];
  const payLink = `${process.env.APP_URL ?? ""}/pay/${invoice.payToken}`;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{invoice.client.name}</h1>
          <p className="text-sm text-muted-foreground">
            {invoice.project?.name} · {invoice.invoiceNumber ?? "not on PayPal yet"} · due {invoice.dueDate.toISOString().slice(0, 10)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={invoice.status} overdueDays={daysOverdue(invoice)} />
          {invoice.status === "DRAFT" ? <SendDraftButton invoiceId={invoice.id} /> : invoice.paypalInvoiceId && <SyncButton invoiceId={invoice.id} />}
          {isMockMode() && open && invoice.paypalInvoiceId && <SimulatePaymentButton paypalInvoiceId={invoice.paypalInvoiceId} />}
        </div>
      </div>

      {invoice.status !== "DRAFT" && (
      <Card>
        <CardHeader>
          <CardDescription>Why hasn&apos;t {invoice.client.name} paid?</CardDescription>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {kase?.reason ? REASON_LABELS[kase.reason] ?? kase.reason : "Not diagnosed yet"}
            {kase?.confidence != null && <Badge variant="outline">confidence {kase.confidence.toFixed(2)}</Badge>}
            {kase?.replayed && <ReplayedBadge />}
            {kase && kase.state !== "open" && (
              <Badge variant={kase.state === "dispute" ? "destructive" : "secondary"}>
                {kase.state}
                {kase.state === "paused" && kase.pausedUntil && ` until ${kase.pausedUntil.toISOString().slice(0, 10)}`}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {kase?.summary && <p className="text-sm">{kase.summary}</p>}
          {evidence.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Evidence from the client&apos;s words</p>
              {evidence.map((q) => (
                <blockquote key={q} className="border-l-2 pl-3 text-sm italic">
                  &ldquo;{q}&rdquo;
                </blockquote>
              ))}
            </div>
          )}
          {kase?.actions.map((a) => (
            <ProposalCard
              key={a.id}
              p={{
                id: a.id,
                type: a.type,
                status: a.status,
                mandateVerdict: a.mandateVerdict,
                mandateReasons: a.mandateReasons as string[],
                draft: a.draft,
                params: a.params as Record<string, unknown>,
                result: a.result,
              }}
            />
          ))}
          {open && kase?.state !== "dispute" ? (
            <div className="space-y-3 border-t pt-4">
              <DiagnosePanel invoiceId={invoice.id} analyzeLabel={daysOverdue(invoice) > 0 ? (kase ? "Re-run diagnosis" : "Diagnose now") : undefined} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {open ? "Automation is stopped while this is in dispute. Reply to the client yourself." : "Nothing left to collect on this invoice."}
            </p>
          )}
        </CardContent>
      </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{formatMoney(invoice.totalMinor, invoice.currency)}</CardTitle>
          <CardDescription>
            {invoice.paidMinor > 0 && `${formatMoney(invoice.paidMinor, invoice.currency)} paid · `}
            {invoice.lastSyncedAt ? `Synced from PayPal ${invoice.lastSyncedAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "Not synced yet"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((it, n) => (
                <TableRow key={n}>
                  <TableCell>{n + 1}</TableCell>
                  <TableCell>
                    {it.name}
                    {it.description && <span className="block text-xs text-muted-foreground">{it.description}</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    {it.quantity} {it.unit === "HOURS" ? "h" : ""}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(it.unitAmountMinor, invoice.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="space-y-1 text-sm">
            {invoice.payerViewUrl && (
              <p>
                PayPal invoice:{" "}
                <a href={invoice.payerViewUrl} target="_blank" rel="noreferrer" className="underline">
                  payer view
                </a>
              </p>
            )}
            <p className="text-muted-foreground">Client page: {payLink}</p>
          </div>
        </CardContent>
      </Card>

      {invoice.project && (
        <Card>
          <CardHeader>
            <CardTitle>Client asking for more?</CardTitle>
            <CardDescription>Check a request against the agreed scope for {invoice.project.name}. Billable extras go onto a draft invoice in one click.</CardDescription>
          </CardHeader>
          <CardContent>
            <ScopeCheck projectId={invoice.project.id} currency={invoice.currency} example={isDemoMode() && invoice.client.name === "Acme Labs" ? ACME_EXTRA : undefined} />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Thread</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {invoice.messages.length === 0 && <p className="text-sm text-muted-foreground">No messages yet.</p>}
            {invoice.messages.map((m) => (
              <div key={m.id} className={`rounded-md border p-3 text-sm ${m.direction === "INBOUND" ? "bg-muted/50" : ""}`}>
                <p className="mb-1 text-xs text-muted-foreground">
                  {m.direction === "INBOUND" ? invoice.client.name : "You"} · {m.sentAt.toISOString().slice(0, 10)} · {m.channel}
                </p>
                {m.body}
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            {invoice.timeline.length === 0 && <p className="text-sm text-muted-foreground">Nothing logged yet.</p>}
            <ol className="space-y-2 text-sm">
              {invoice.timeline.map((t) => (
                <li key={t.id}>
                  <span className="text-xs text-muted-foreground">{t.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>{" "}
                  {t.summary}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
