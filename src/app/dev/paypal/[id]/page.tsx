import Link from "next/link";
import { notFound } from "next/navigation";
import { SimulatePaymentButton } from "@/components/simulate-payment-button";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/lib/db";
import { isMockMode } from "@/paypal/client";
import { mockInvoice } from "@/paypal/mock";

// Stands in for PayPal's hosted invoice page when PAYPAL_MODE=mock. 404 otherwise.
export default async function MockPayPalPage({ params }: PageProps<"/dev/paypal/[id]">) {
  if (!isMockMode()) notFound();
  const { id } = await params;
  const inv = mockInvoice(id);
  if (!inv) notFound();
  const local = await db.invoice.findUnique({ where: { paypalInvoiceId: id }, select: { payToken: true } });
  const due = Number(inv.due_amount.value) > 0;
  return (
    <main className="mx-auto w-full max-w-md space-y-4 p-4 py-10">
      <Card>
        <CardHeader>
          <CardDescription>PayPal (mock) · invoice {inv.detail.invoice_number}</CardDescription>
          <CardTitle className="text-3xl tabular-nums">
            {inv.due_amount.currency_code} {due ? inv.due_amount.value : inv.amount.value}
          </CardTitle>
          <p className="text-sm text-muted-foreground">Status: {inv.status.replaceAll("_", " ").toLowerCase()}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          {due ? <SimulatePaymentButton paypalInvoiceId={id} size="lg" /> : <p className="text-sm">Nothing left to pay.</p>}
          {local && (
            <Link href={`/pay/${local.payToken}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Back to the invoice
            </Link>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
