"use client";

import { useActionState } from "react";
import { markSentAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

export function MarkSentButton({ messageId }: { messageId: string }) {
  const [state, action, pending] = useActionState(() => markSentAction(messageId), {});
  return (
    <form action={action} className="flex items-center gap-2">
      {state.error && <span className="text-xs text-destructive">{state.error}</span>}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        Mark as sent
      </Button>
    </form>
  );
}
