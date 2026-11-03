"use client";

import { useActionState, useRef } from "react";
import { resetDemoAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

export function ResetDemo() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, action, pending] = useActionState(async () => {
    const result = await resetDemoAction();
    dialog.current?.close();
    return result;
  }, {});
  return (
    <>
      <Button type="button" variant="outline" onClick={() => dialog.current?.showModal()} disabled={pending}>
        {pending ? "Resetting…" : "Reset demo"}
      </Button>
      {state.done && <span className="text-sm text-muted-foreground" role="status">Demo reset. All three stories are back at the start.</span>}
      {state.error && <span className="text-sm text-destructive" role="alert">{state.error}</span>}
      <dialog ref={dialog} aria-labelledby="reset-title" className="m-auto max-w-sm rounded-lg border bg-background p-6 text-foreground shadow-lg backdrop:bg-black/40">
        <form action={action} className="space-y-4">
          <h2 id="reset-title" className="text-lg font-semibold">Reset the demo?</h2>
          <p className="text-sm text-muted-foreground">
            This replaces Aarav&apos;s clients, invoices, chats and approvals with the three starting stories, and cancels the old PayPal invoices. Anyone else signed in to the demo sees the reset too.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Resetting…" : "Reset demo"}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
