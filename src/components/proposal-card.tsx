"use client";

import Link from "next/link";
import { useActionState } from "react";
import { decideProposalAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { describeProposal, STATUS_LABELS } from "@/lib/proposals";

export interface ProposalView {
  id: string;
  type: string;
  status: string;
  mandateVerdict: string;
  mandateReasons: string[];
  draft: string | null;
  params: Record<string, unknown>;
  result: unknown;
  context?: { label: string; href: string };
}

const verdictVariant = (v: string) => (v === "allow" ? "default" : v === "deny" ? "destructive" : "secondary");

export function ProposalCard({ p }: { p: ProposalView }) {
  const [state, action, pending] = useActionState(decideProposalAction.bind(null, p.id), {});
  const { title, detail } = describeProposal(p.type, p.params);
  const open = p.status === "pending";
  const error = (p.result as { error?: string } | null)?.error;

  return (
    <div className="space-y-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          {p.context && (
            <Link href={p.context.href} className="text-xs text-muted-foreground hover:underline">
              {p.context.label}
            </Link>
          )}
          <p className="font-medium">{title}</p>
          {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        </div>
        <div className="flex gap-1" data-tour="mandate-verdict">
          <Badge variant={verdictVariant(p.mandateVerdict)}>mandate: {p.mandateVerdict.replace("_", " ")}</Badge>
          <Badge variant="outline">{STATUS_LABELS[p.status] ?? p.status}</Badge>
        </div>
      </div>
      <ul className="list-disc pl-5 text-xs text-muted-foreground">
        {p.mandateReasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <form action={action} className="space-y-2">
        {p.draft !== null &&
          (open ? (
            <Textarea name="draft" defaultValue={p.draft} rows={5} aria-label="Draft (editable)" />
          ) : (
            <p className="rounded-md bg-muted/50 p-3 text-sm whitespace-pre-wrap">{p.draft}</p>
          ))}
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
        {open && (
          <div className="flex gap-2">
            <Button type="submit" name="decision" value="approve" size="sm" disabled={pending}>
              {pending ? "Working…" : "Approve"}
            </Button>
            <Button type="submit" name="decision" value="reject" size="sm" variant="outline" disabled={pending}>
              Reject
            </Button>
          </div>
        )}
      </form>
    </div>
  );
}
