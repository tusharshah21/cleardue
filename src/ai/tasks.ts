// AI tasks. Each takes its model as a parameter (getModel() in the app, a mock in tests).
import type { LanguageModel } from "ai";
import * as classifyPrompt from "./prompts/classify-reply";
import * as payerPrompt from "./prompts/payer-assistant";
import { ClassifyReplySchema, PayerAnswerSchema, type ClassifyReply, type PayerAnswer } from "./schemas";
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

export interface PayerSources {
  scope: string;
  invoice: string;
  thread: string;
}

// Figures that read as money or a percentage: "50%", "$1,200", "AUD 600.00", "600.00".
const FIGURES = /\d[\d,]*(?:\.\d+)?\s*%|(?:[$£€₹]|\b[A-Z]{3}\s?)\d[\d,]*(?:\.\d+)?|\b\d[\d,]*\.\d{2}\b/g;
const numberOf = (s: string) => s.replace(/[^\d.]/g, "").replace(/\.0+$/, "");

const escalated = (freelancerName: string, why: string): PayerAnswer => ({
  answer: `I can't answer that from the agreed scope or this invoice, so I've passed your message to ${freelancerName}. They'll reply to you directly.`,
  citations: [],
  escalate: true,
  escalationReason: why.slice(0, 300),
  complaint: false,
});

/** Grounding guard: citations must quote their source verbatim, an answer needs at least one surviving citation,
 * and it may not state money or percentage figures that the sources don't contain (no invented discounts). */
export function groundAnswer(a: PayerAnswer, sources: PayerSources, freelancerName: string): PayerAnswer {
  const citations = a.citations.filter((c) => norm(sources[c.source]).includes(norm(c.quote).replace(/^["']|["']$/g, "")));
  if (a.escalate) return { ...a, citations };
  const known = new Set((Object.values(sources).join("\n").match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(numberOf));
  const invented = (a.answer.match(FIGURES) ?? []).filter((f) => !known.has(numberOf(f)));
  if (invented.length) return { ...escalated(freelancerName, `answer stated figures not in the sources: ${invented.join(", ")}`), complaint: a.complaint };
  if (!citations.length) return { ...escalated(freelancerName, "answer had no verifiable citation"), complaint: a.complaint };
  return { ...a, citations };
}

export async function payerAssistant(
  model: LanguageModel,
  input: { freelancerName: string; sources: PayerSources; question: string },
): Promise<StructuredResult<PayerAnswer>> {
  const result = await structured({
    model,
    schema: PayerAnswerSchema,
    system: payerPrompt.system,
    prompt: payerPrompt.buildPrompt({ freelancerName: input.freelancerName, ...input.sources, question: input.question }),
    fallback: (error) => escalated(input.freelancerName, `couldn't answer automatically (${error.slice(0, 200)})`),
  });
  return result.fallback ? result : { ...result, value: groundAnswer(result.value, input.sources, input.freelancerName) };
}
