"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const STAGES = [
  { key: "reading", label: "Reading the conversation" },
  { key: "diagnosing", label: "Working out why it's unpaid" },
  { key: "proposing", label: "Choosing actions within your mandate" },
  { key: "saving", label: "Saving to the timeline" },
];

/** Paste a client reply and/or re-run the diagnosis, with live progress streamed from the server. */
export function DiagnosePanel({ invoiceId, analyzeLabel }: { invoiceId: string; analyzeLabel?: string }) {
  const router = useRouter();
  const [reply, setReply] = useState("");
  const [seen, setSeen] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(withReply: boolean) {
    setRunning(true);
    setError(null);
    setSeen([]);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/diagnose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withReply ? { reply } : {}),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? "Diagnosis failed");
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const msg = JSON.parse(line) as { stage?: string; error?: string; done?: boolean };
          if (msg.stage) setSeen((s) => [...s, msg.stage!]);
          if (msg.error) throw new Error(msg.error);
        }
      }
      if (withReply) setReply("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const current = seen.at(-1);
  return (
    <div className="space-y-3">
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (reply.trim()) run(true);
        }}
      >
        <Textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={3} maxLength={5000} placeholder="Paste the client's latest reply…" aria-label="Client reply" />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={running || !reply.trim()}>
            Add reply and diagnose
          </Button>
          {analyzeLabel && (
            <Button type="button" size="sm" variant="outline" disabled={running} onClick={() => run(false)}>
              {analyzeLabel}
            </Button>
          )}
        </div>
      </form>
      {(running || seen.length > 0) && (
        <ol className="space-y-1 text-sm" aria-live="polite">
          {STAGES.filter((s) => seen.includes(s.key)).map((s) => (
            <li key={s.key} className={s.key === current && running ? "font-medium" : "text-muted-foreground"}>
              {s.key === current && running ? "… " : "✓ "}
              {s.label}
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
