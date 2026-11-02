"use client";

import { useActionState } from "react";
import { saveMandateAction } from "@/app/actions";
import type { Mandate } from "@/agent/mandate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fromMinor } from "@/lib/money";

const field = "space-y-1";
const select = "h-9 w-full rounded-md border bg-transparent px-3 text-sm";

export function MandateForm({ clientId, mandate, currency }: { clientId: string; mandate: Mandate; currency: string }) {
  const [state, action, pending] = useActionState(saveMandateAction.bind(null, clientId), {});
  const id = (name: string) => `${clientId}-${name}`;
  const min = mandate.minFirstPayment;
  return (
    <form action={action} className="space-y-4">
      <div className="flex flex-wrap gap-6 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="autopilot" defaultChecked={mandate.autopilot} className="size-4" />
          Autopilot (act without asking, inside these limits)
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" name="neverAutoContact" defaultChecked={mandate.neverAutoContact} className="size-4" />
          Never contact automatically
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className={field}>
          <Label htmlFor={id("conf")}>Min. confidence</Label>
          <Input id={id("conf")} name="minConfidence" type="number" step="0.01" min="0" max="1" defaultValue={mandate.minConfidence} required />
        </div>
        <div className={field}>
          <Label htmlFor={id("tone")}>Tone ceiling</Label>
          <select id={id("tone")} name="toneCeiling" defaultValue={mandate.toneCeiling} className={select}>
            <option value="friendly">Friendly</option>
            <option value="firm">Firm</option>
            <option value="formal">Formal</option>
          </select>
        </div>
        <div className={field}>
          <Label htmlFor={id("inst")}>Max instalments</Label>
          <Input id={id("inst")} name="maxInstalments" type="number" min="1" max="12" defaultValue={mandate.maxInstalments} required />
        </div>
        <div className={field}>
          <Label htmlFor={id("first")}>Min. first payment</Label>
          <div className="flex gap-2">
            <Input id={id("first")} name="minFirstValue" inputMode="decimal" defaultValue={min.kind === "percent" ? min.value : fromMinor(min.valueMinor, currency)} required />
            <select name="minFirstKind" defaultValue={min.kind} className={`${select} w-24`} aria-label="Minimum first payment unit">
              <option value="percent">%</option>
              <option value="amount">{currency}</option>
            </select>
          </div>
        </div>
        <div className={field}>
          <Label htmlFor={id("days")}>Latest final payment (days after due)</Label>
          <Input id={id("days")} name="maxPlanDays" type="number" min="0" max="365" defaultValue={mandate.maxPlanDays} required />
        </div>
        <div className={field}>
          <Label htmlFor={id("qs")}>Quiet hours (client time)</Label>
          <div className="flex items-center gap-2">
            <Input id={id("qs")} name="quietStart" type="number" min="0" max="23" defaultValue={mandate.quietHours.start} required aria-label="Quiet hours start" />
            <span className="text-sm">to</span>
            <Input name="quietEnd" type="number" min="0" max="23" defaultValue={mandate.quietHours.end} required aria-label="Quiet hours end" />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save mandate"}
        </Button>
        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : (
          state.saved && <p className="text-sm text-muted-foreground">Saved.</p>
        )}
      </div>
    </form>
  );
}
