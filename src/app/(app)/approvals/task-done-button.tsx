"use client";

import { useActionState } from "react";
import { completeTaskAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

export function TaskDoneButton({ taskId }: { taskId: string }) {
  const [state, action, pending] = useActionState(() => completeTaskAction(taskId), {});
  return (
    <form action={action} className="flex items-center gap-2">
      {state.error && <span className="text-xs text-destructive">{state.error}</span>}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        Mark handled
      </Button>
    </form>
  );
}
