"use client";

import { Button } from "@/components/ui/button";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md space-y-3 rounded-lg border p-6 text-center">
      <h1 className="text-lg font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">Nothing was sent to PayPal or your client. Try again; if it keeps happening, check the server logs.</p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
