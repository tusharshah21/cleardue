// AI tasks. Each takes its model as a parameter (getModel() in the app, a mock in tests).
import type { LanguageModel } from "ai";
import type { Budget } from "./budget";
import type { CacheScope } from "./cache";
import * as classifyPrompt from "./prompts/classify-reply";
import * as payerPrompt from "./prompts/payer-assistant";
import * as scopePrompt from "./prompts/scope-check";
import { ClassifyReplySchema, PayerAnswerSchema, ScopeCheckSchema, type ClassifyReply, type PayerAnswer, type ScopeCheck } from "./schemas";
import { mentionsPaymentRail } from "@/lib/payment-rails";
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
  input: { clientName: string; invoiceSummary: string; thread: ThreadMessage[]; now?: Date; cacheScope?: CacheScope | null; budget?: Budget },
): Promise<StructuredResult<ClassifyReply>> {
  const today = (input.now ?? new Date()).toISOString().slice(0, 10);
  const result = await structured({
    model,
    budget: input.budget,
    schema: ClassifyReplySchema,
    system: classifyPrompt.system,
    // Replies and the day (relative dates like "Friday" resolve against it), not the timestamps, which shift on every reseed.
    cache: { scope: input.cacheScope, task: "classify_reply", parts: [classifyPrompt.system, today, input.clientName, input.invoiceSummary, input.thread.map((m) => [m.from, m.body])] },
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

/** Grounding guard: clauses must be verbatim from the scope; a verdict with no surviving clause becomes GRAY_ZONE. */
export function groundScopeCheck(s: ScopeCheck, scope: string): ScopeCheck {
  const quotedClauses = s.quotedClauses.filter((q) => norm(scope).includes(norm(q).replace(/^["']|["']$/g, "")));
  if (quotedClauses.length) return { ...s, quotedClauses };
  return { ...s, quotedClauses, verdict: "GRAY_ZONE", reasoning: `No scope clause could be verified for this verdict. ${s.reasoning}`.slice(0, 600) };
}

export async function scopeCheck(model: LanguageModel, input: { scope: string; request: string; cacheScope?: CacheScope | null }): Promise<StructuredResult<ScopeCheck>> {
  const result = await structured({
    model,
    cache: { scope: input.cacheScope, task: "scope_check", parts: [scopePrompt.system, input.scope, input.request] },
    schema: ScopeCheckSchema,
    system: scopePrompt.system,
    prompt: scopePrompt.buildPrompt(input),
    fallback: (error): ScopeCheck => ({
      verdict: "GRAY_ZONE",
      quotedClauses: [],
      reasoning: `Couldn't check this automatically (${error.slice(0, 200)}). Compare it with the scope yourself.`,
      estimatedHours: null,
      suggestedLineItem: null,
    }),
  });
  return result.fallback ? result : { ...result, value: groundScopeCheck(result.value, input.scope) };
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
  wantsPlan: false,
});

/** Grounding guard: citations must quote their source verbatim, an answer needs at least one surviving citation,
 * and it may not state money or percentage figures that the sources don't contain (no invented discounts).
 * Figures computed by code (outstanding, paid, plan options) are part of the INVOICE source, so they pass. */
export function groundAnswer(a: PayerAnswer, sources: PayerSources, freelancerName: string): PayerAnswer {
  const citations = a.citations.filter((c) => norm(sources[c.source]).includes(norm(c.quote).replace(/^["']|["']$/g, "")));
  if (a.escalate) return { ...a, citations };
  // The pay page never discusses bank details or another way to pay on its own: that is the freelancer's call (an escalated refusal is fine).
  if (mentionsPaymentRail(a.answer)) return { ...escalated(freelancerName, "the client asked about paying outside the PayPal invoice"), complaint: a.complaint, wantsPlan: a.wantsPlan };
  const known = new Set((Object.values(sources).join("\n").match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(numberOf));
  const invented = (a.answer.match(FIGURES) ?? []).filter((f) => !known.has(numberOf(f)));
  if (invented.length) return { ...escalated(freelancerName, `answer stated figures not in the sources: ${invented.join(", ")}`), complaint: a.complaint, wantsPlan: a.wantsPlan };
  if (!citations.length) return { ...escalated(freelancerName, "answer had no verifiable citation"), complaint: a.complaint, wantsPlan: a.wantsPlan };
  return { ...a, citations };
}

export async function payerAssistant(
  model: LanguageModel,
  input: { freelancerName: string; sources: PayerSources; question: string; cacheScope?: CacheScope | null },
): Promise<StructuredResult<PayerAnswer>> {
  const result = await structured({
    model,
    cache: { scope: input.cacheScope, task: "payer_assistant", parts: [payerPrompt.system, input.freelancerName, input.sources, input.question] },
    schema: PayerAnswerSchema,
    system: payerPrompt.system,
    prompt: payerPrompt.buildPrompt({ freelancerName: input.freelancerName, ...input.sources, question: input.question }),
    fallback: (error) => escalated(input.freelancerName, `couldn't answer automatically (${error.slice(0, 200)})`),
  });
  return result.fallback ? result : { ...result, value: groundAnswer(result.value, input.sources, input.freelancerName) };
}
