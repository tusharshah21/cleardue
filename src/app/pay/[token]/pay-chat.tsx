"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const MAX_QUESTION = 500; // mirrors MAX_QUESTION in src/ai/schemas.ts

export interface ChatEntry {
  question: string;
  answer: string;
  citations: { source: string; quote: string }[];
  escalated: boolean;
  replayed: boolean;
  cached?: boolean;
}

const SOURCE_LABEL: Record<string, string> = { scope: "Scope of work", invoice: "Invoice", thread: "Earlier messages" };

export function PayChat({ token, history, suggestions, freelancerName }: { token: string; history: ChatEntry[]; suggestions: string[]; freelancerName: string }) {
  const router = useRouter();
  const [entries, setEntries] = useState(history);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function ask(q: string) {
    if (!q.trim() || pending) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/pay/${encodeURIComponent(token)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Something went wrong");
      setEntries((e) => [...e, { question: q, answer: data.answer, citations: data.citations, escalated: data.escalated, replayed: data.replayed, cached: data.cached }]);
      setQuestion("");
      if (data.plansAvailable) router.refresh(); // show the plan options the request unlocked
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <ol className="space-y-4" aria-live="polite">
        {entries.map((e, i) => (
          <li key={i} className="space-y-2">
            <p className="ml-auto w-fit max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">{e.question}</p>
            <div className="max-w-[90%] rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              <p>{e.answer}</p>
              {e.citations.length > 0 && (
                <ul className="mt-2 space-y-1 border-t pt-2 text-xs text-muted-foreground">
                  {e.citations.map((c, j) => (
                    <li key={j}>
                      <span className="font-medium text-foreground">{SOURCE_LABEL[c.source] ?? c.source}:</span> “{c.quote}”
                    </li>
                  ))}
                </ul>
              )}
              {e.escalated && <p className="mt-2 text-xs text-muted-foreground">Sent to {freelancerName} to answer personally.</p>}
              {e.cached && (
                <p className="mt-2 text-xs text-sky-700" title="An identical question was answered live earlier; that result was reused to stay within the AI quota">
                  Cached result from an earlier live run
                </p>
              )}
              {e.replayed && (
                <p className="mt-2 text-xs text-amber-700" title="DEMO_MODE served a recorded AI response instead of calling the model">
                  Replayed response (demo mode)
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>

      {entries.length === 0 && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => (
            <Button key={s} type="button" size="sm" variant="outline" disabled={pending} onClick={() => ask(s)}>
              {s}
            </Button>
          ))}
        </div>
      )}

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          maxLength={MAX_QUESTION}
          placeholder="Ask about this invoice or the work it covers…"
          aria-label="Your question"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {question.length}/{MAX_QUESTION}
          </span>
          <Button type="submit" size="sm" disabled={pending || !question.trim()}>
            {pending ? "Checking…" : "Ask"}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
