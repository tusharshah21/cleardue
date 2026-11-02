"use client";

import { useActionState } from "react";
import { createClientAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const fields = [
  { name: "name", label: "Client name", required: true },
  { name: "email", label: "Billing email", type: "email", required: true },
  { name: "approverEmail", label: "Approver / AP email (optional)", type: "email" },
  { name: "country", label: "Country (ISO code, e.g. US)", required: true, maxLength: 2 },
  { name: "currency", label: "Currency (e.g. USD)", required: true, maxLength: 3 },
  { name: "timezone", label: "Timezone (e.g. America/New_York)", required: true },
  { name: "projectName", label: "Project name", required: true },
];

export function NewClientForm() {
  const [state, action, pending] = useActionState(createClientAction, {});
  return (
    <form action={action} className="space-y-3">
      {fields.map((f) => (
        <div key={f.name} className="space-y-1">
          <Label htmlFor={f.name}>{f.label}</Label>
          <Input id={f.name} name={f.name} type={f.type ?? "text"} required={f.required} maxLength={f.maxLength} />
        </div>
      ))}
      <div className="space-y-1">
        <Label htmlFor="scope">Agreed scope</Label>
        <Textarea id="scope" name="scope" rows={8} required placeholder="1. Discovery workshop…" />
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Saving…" : "Add client"}
      </Button>
    </form>
  );
}
