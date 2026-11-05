"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { acceptPlanAction, markPaidSandboxAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

export function PlanOption({ token, index, label }: { token: string; index: number; label: string }) {
  const [state, action, pending] = useActionState(() => acceptPlanAction(token, index), {});
  return (
    <form action={action} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <span className="text-sm">{label}</span>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Setting up…" : "Accept this plan"}
      </Button>
      {state.error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}

/** Re-renders the page every 10 s while the freelancer is confirming a plan. */
export function AutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(t);
  }, [router]);
  return null;
}

/** Sandbox only: records a test payment through the Invoicing API, for a judge without a sandbox buyer account. */
export function MarkPaid({ token, invoiceId, size = "default" }: { token: string; invoiceId: string; size?: "default" | "sm" }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(async () => {
    const r = await markPaidSandboxAction(token, invoiceId);
    if (!r.error) router.refresh();
    return r;
  }, {});
  return (
    <form action={action} className="space-y-1">
      <Button type="submit" size={size} variant="outline" className={size === "default" ? "w-full" : undefined} disabled={pending}>
        {pending ? "Recording…" : "Mark as paid (sandbox test)"}
      </Button>
      <p className="text-xs text-muted-foreground">Sandbox testing only: records a test payment on this PayPal sandbox invoice. No real money moves.</p>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  );
}
