"use client";

import { useActionState, useState } from "react";
import { createInvoiceAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface Item {
  name: string;
  quantity: string;
  unitAmount: string;
  unit: "HOURS" | "AMOUNT";
}
const blank = (): Item => ({ name: "", quantity: "1", unitAmount: "", unit: "AMOUNT" });
const selectClass = "h-9 w-full rounded-md border bg-transparent px-2 text-sm";

export function NewInvoiceForm({ projects }: { projects: { id: string; label: string; currency: string }[] }) {
  const [defaultDue] = useState(() => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  const [state, action, pending] = useActionState(createInvoiceAction, {});
  const [projectId, setProjectId] = useState(projects[0].id);
  const [items, setItems] = useState<Item[]>([blank()]);
  const currency = projects.find((p) => p.id === projectId)?.currency ?? "";
  const set = (i: number, patch: Partial<Item>) => setItems(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="projectId">Client and project</Label>
          <select id="projectId" name="projectId" className={selectClass} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="dueDate">Due date</Label>
          <Input id="dueDate" name="dueDate" type="date" required defaultValue={defaultDue} />
        </div>
      </div>

      <Card>
        <CardContent className="space-y-3">
          {items.map((it, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[1fr_5rem_7rem_7rem_auto] sm:items-end">
              <div className="space-y-1">
                <Label htmlFor={`name-${i}`}>Line item</Label>
                <Input id={`name-${i}`} required value={it.name} onChange={(e) => set(i, { name: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`qty-${i}`}>Qty</Label>
                <Input id={`qty-${i}`} required inputMode="decimal" value={it.quantity} onChange={(e) => set(i, { quantity: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`amt-${i}`}>Unit price ({currency})</Label>
                <Input id={`amt-${i}`} required inputMode="decimal" placeholder="0.00" value={it.unitAmount} onChange={(e) => set(i, { unitAmount: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`unit-${i}`}>Unit</Label>
                <select id={`unit-${i}`} className={selectClass} value={it.unit} onChange={(e) => set(i, { unit: e.target.value as Item["unit"] })}>
                  <option value="AMOUNT">Fixed</option>
                  <option value="HOURS">Hours</option>
                </select>
              </div>
              <Button type="button" variant="ghost" disabled={items.length === 1} onClick={() => setItems(items.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" onClick={() => setItems([...items, blank()])}>
            Add line item
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-1">
        <Label htmlFor="note">Note to client (optional)</Label>
        <Textarea id="note" name="note" rows={3} maxLength={4000} />
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Sending through PayPal…" : "Create and send with PayPal"}
      </Button>
    </form>
  );
}
