"use client";

import { useActionState } from "react";
import { addLineAction, scopeCheckAction, sendDraftAction, type ScopeState } from "@/app/actions";
import { ReplayedBadge } from "@/components/replayed-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const VERDICT = {
  IN_SCOPE: { label: "In scope", variant: "secondary" },
  GRAY_ZONE: { label: "Gray zone", variant: "outline" },
  OUT_OF_SCOPE: { label: "Out of scope", variant: "destructive" },
} as const;

export function ScopeCheck({ projectId, currency, example }: { projectId: string; currency: string; example?: string }) {
  const [state, action, pending] = useActionState<ScopeState, FormData>(scopeCheckAction.bind(null, projectId), {});
  const r = state.result;
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-2">
        <Textarea name="request" rows={2} maxLength={2000} required defaultValue={state.request ?? example} placeholder="What is the client asking for?" aria-label="Client request" />
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? "Checking…" : "Check against scope"}
        </Button>
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </form>

      {r && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={VERDICT[r.verdict].variant}>{VERDICT[r.verdict].label}</Badge>
            {r.estimatedHours != null && <span className="text-sm text-muted-foreground">about {r.estimatedHours} h of work</span>}
            {state.replayed && <ReplayedBadge />}
          </div>
          <p className="text-sm">{r.reasoning}</p>
          {r.quotedClauses.map((q) => (
            <blockquote key={q} className="border-l-2 pl-3 text-sm italic">
              &ldquo;{q}&rdquo;
            </blockquote>
          ))}
          {r.suggestedLineItem && <AddLine projectId={projectId} currency={currency} rate={state.rate} item={r.suggestedLineItem} />}
        </div>
      )}
    </div>
  );
}

function AddLine({ projectId, currency, rate, item }: { projectId: string; currency: string; rate?: string; item: { name: string; description: string; hours: number } }) {
  const [state, action, pending] = useActionState(addLineAction.bind(null, projectId), {});
  return (
    <form action={action} className="grid gap-2 border-t pt-3 sm:grid-cols-[1fr_6rem_8rem]">
      <div className="space-y-1">
        <Label htmlFor="line-name">Line item</Label>
        <Input id="line-name" name="name" defaultValue={item.name} required maxLength={200} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="line-hours">Hours</Label>
        <Input id="line-hours" name="hours" type="number" step="0.25" min="0.25" defaultValue={item.hours} required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="line-rate">Rate ({currency}/h)</Label>
        <Input id="line-rate" name="rate" inputMode="decimal" defaultValue={rate} required />
      </div>
      <input type="hidden" name="description" value={item.description} />
      <div className="sm:col-span-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Adding…" : "Add to draft invoice"}
        </Button>
        {state.error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {state.error}
          </p>
        )}
      </div>
    </form>
  );
}

export function SendDraftButton({ invoiceId }: { invoiceId: string }) {
  const [state, action, pending] = useActionState(() => sendDraftAction(invoiceId), {});
  return (
    <form action={action} className="flex items-center gap-2">
      {state.error && <span className="max-w-xs text-xs text-destructive">{state.error}</span>}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Sending…" : "Send through PayPal"}
      </Button>
    </form>
  );
}
