"use client";

import { useActionState } from "react";
import { syncInvoiceAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

export function SyncButton({ invoiceId }: { invoiceId: string }) {
  const [state, action, pending] = useActionState(() => syncInvoiceAction(invoiceId), {});
  return (
    <form action={action} className="flex items-center gap-2">
      {state.error && <span role="alert" className="max-w-xs text-xs text-destructive">{state.error}</span>}
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Syncing…" : "Sync from PayPal"}
      </Button>
    </form>
  );
}
