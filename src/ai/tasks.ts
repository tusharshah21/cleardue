// AI tasks. Each takes its model as a parameter (getModel() in the app, a mock in tests).
import type { LanguageModel } from "ai";
import * as classifyPrompt from "./prompts/classify-reply";
import { ClassifyReplySchema, type ClassifyReply } from "./schemas";
import { structured, type StructuredResult } from "./structured";

export interface ThreadMessage {
  from: "client" | "freelancer";
  at: Date;
  body: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

/** Grounding guard: evidence must be quoted from the client's own words; unsupported labels lose confidence. */
export function groundClassification(c: ClassifyReply, thread: ThreadMessage[]): ClassifyReply {
  const clientText = norm(thread.filter((m) => m.from === "client").map((m) => m.body).join("\n"));
  const evidence = c.evidence.filter((q) => clientText.includes(norm(q).replace(/^["']|["']$/g, "")));
  const unsupported = c.reason !== "other" && evidence.length === 0;
  return { ...c, evidence, confidence: unsupported ? Math.min(c.confidence, 0.5) : c.confidence };
}

export async function classifyReply(
  model: LanguageModel,
  input: { clientName: string; invoiceSummary: string; thread: ThreadMessage[]; now?: Date },
): Promise<StructuredResult<ClassifyReply>> {
  const today = (input.now ?? new Date()).toISOString().slice(0, 10);
  const result = await structured({
    model,
    schema: ClassifyReplySchema,
    system: classifyPrompt.system,
    prompt: classifyPrompt.buildPrompt({
      today,
      clientName: input.clientName,
      invoiceSummary: input.invoiceSummary,
      thread: input.thread.map((m) => ({ from: m.from, at: m.at.toISOString().slice(0, 10), body: m.body })),
    }),
    fallback: (error): ClassifyReply => ({
      reason: "other",
      confidence: 0,
      evidence: [],
      promisedDate: null,
      approverEmail: null,
      summary: `Couldn't classify this automatically (${error.slice(0, 200)}). Please review the reply yourself.`,
    }),
  });
  return result.fallback ? result : { ...result, value: groundClassification(result.value, input.thread) };
}
