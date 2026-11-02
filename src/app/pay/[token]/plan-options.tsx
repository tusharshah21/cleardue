"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";
import { acceptPlanAction } from "@/app/actions";
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
