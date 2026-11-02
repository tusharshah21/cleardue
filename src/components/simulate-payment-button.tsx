"use client";

import { useActionState } from "react";
import { simulatePaymentAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

export function SimulatePaymentButton({ paypalInvoiceId, size = "sm" }: { paypalInvoiceId: string; size?: "sm" | "lg" }) {
  const [state, action, pending] = useActionState(() => simulatePaymentAction(paypalInvoiceId), {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <Button type="submit" size={size} variant="outline" disabled={pending}>
        {pending ? "Paying…" : "Simulate client payment"}
      </Button>
      {state.error && (
        <span role="alert" className="text-xs text-destructive">
          {state.error}
        </span>
      )}
    </form>
  );
}
