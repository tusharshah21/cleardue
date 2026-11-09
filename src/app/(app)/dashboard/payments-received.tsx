import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import type { PaymentsResult } from "@/paypal/transactions";

const time = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** "Payments received (live from PayPal)": what Transaction Search says arrived, each matched against ClearDue's own
 * invoice numbers, so the freelancer sees PayPal's record next to ours. */
export function PaymentsReceived({ result, ourNumbers }: { result: PaymentsResult; ourNumbers: Set<string> }) {
  const totals = new Map<string, number>();
  for (const r of result.rows) if (r.status === "Completed") totals.set(r.currency, (totals.get(r.currency) ?? 0) + r.amountMinor);
  const matched = result.rows.filter((r) => r.invoiceNumber && ourNumbers.has(r.invoiceNumber)).length;
  return (
    <Card data-testid="paypal-payments">
      <CardHeader>
        <CardTitle>Payments received (live from PayPal)</CardTitle>
        <p className="text-sm text-muted-foreground">
          Last {result.days} days, read from PayPal Transaction Search, not from ClearDue&apos;s records.
          {result.ok && result.refreshedAt && <> PayPal last updated this at {time(result.refreshedAt)}; it can run up to three hours behind.</>}
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!result.ok ? (
          <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
            {result.message} Everything else on this page comes from ClearDue&apos;s own records and is unaffected.
          </p>
        ) : result.rows.length === 0 ? (
          <p className="text-muted-foreground">PayPal shows no payments received in the last {result.days} days.</p>
        ) : (
          <>
            <p>
              <strong>{result.rows.length}</strong> {result.rows.length === 1 ? "payment" : "payments"} in PayPal
              {totals.size > 0 && <>, {[...totals].map(([c, v]) => formatMoney(v, c)).join(" · ")} completed</>}. {matched} {matched === 1 ? "matches" : "match"} a ClearDue invoice number.
            </p>
            <ul className="divide-y">
              {result.rows.slice(0, 5).map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    {r.date.slice(0, 10)} · {r.payer ?? "Unknown payer"}
                    <span className="text-muted-foreground"> · {r.invoiceNumber ? (ourNumbers.has(r.invoiceNumber) ? `invoice ${r.invoiceNumber} in ClearDue` : `invoice ${r.invoiceNumber}, not in ClearDue`) : "no invoice number"}</span>
                  </span>
                  <span className="tabular-nums">
                    {formatMoney(r.amountMinor, r.currency)} <span className="text-muted-foreground">{r.status}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
