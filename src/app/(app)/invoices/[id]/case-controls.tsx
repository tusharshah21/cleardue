"use client";

import { useActionState } from "react";
import { addReplyAction, analyzeAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function ReplyForm({ invoiceId }: { invoiceId: string }) {
  const [state, action, pending] = useActionState(addReplyAction.bind(null, invoiceId), {});
  return (
    <form action={action} className="space-y-2">
      <Textarea name="body" rows={3} maxLength={5000} required placeholder="Paste the client's latest reply…" aria-label="Client reply" />
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Diagnosing…" : "Add reply and diagnose"}
      </Button>
    </form>
  );
}

export function AnalyzeButton({ invoiceId, label }: { invoiceId: string; label: string }) {
  const [state, action, pending] = useActionState(() => analyzeAction(invoiceId), {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Diagnosing…" : label}
      </Button>
      {state.error && (
        <span role="alert" className="text-xs text-destructive">
          {state.error}
        </span>
      )}
    </form>
  );
}
