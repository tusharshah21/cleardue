// Zod schemas for every AI task. Model output is never trusted until it parses here.
import { z } from "zod";

export const REASONS = [
  "forgot",
  "awaiting_approval",
  "cash_constraint",
  "dispute",
  "wrong_contact",
  "promised_date",
  "claims_paid",
  "other",
] as const;
export const Reason = z.enum(REASONS);
export type Reason = z.infer<typeof Reason>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const ClassifyReplySchema = z.object({
  reason: Reason,
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1)).max(5).describe("Verbatim quotes from the client's messages that support the reason"),
  promisedDate: isoDate.nullable().describe("A payment date the client committed to, if any"),
  approverEmail: z.email().nullable().describe("An approver / accounts payable email the client mentioned, if any"),
  summary: z.string().min(1).max(400).describe("One or two sentences for the freelancer"),
});
export type ClassifyReply = z.infer<typeof ClassifyReplySchema>;

/** Longest pay-page question accepted (enforced by the chat route, mirrored by the input). */
export const MAX_QUESTION = 500;

export const CitationSource =z.enum(["scope", "invoice", "thread"]);
export const PayerAnswerSchema = z.object({
  answer: z.string().min(1).max(1200).describe("Plain-language answer to the payer, in the freelancer's assistant voice"),
  citations: z
    .array(z.object({ source: CitationSource, quote: z.string().min(1).max(400).describe("Exact words copied from that source") }))
    .max(5),
  escalate: z.boolean().describe("True when the sources don't answer the question or the payer asks for something only the freelancer can decide"),
  escalationReason: z.string().max(300).nullable(),
  complaint: z.boolean().describe("True when the payer disputes the work, the amount or the quality"),
  wantsPlan: z.boolean().describe("True when the payer asks to pay in parts, in instalments, or to split the invoice"),
});
export type PayerAnswer = z.infer<typeof PayerAnswerSchema>;

export const ScopeCheckSchema = z.object({
  verdict: z.enum(["IN_SCOPE", "GRAY_ZONE", "OUT_OF_SCOPE"]),
  quotedClauses: z.array(z.string().min(1).max(600)).max(4).describe("Exact clauses from the scope that decide the verdict"),
  reasoning: z.string().min(1).max(600),
  estimatedHours: z.number().min(0).max(500).nullable(),
  suggestedLineItem: z
    .object({ name: z.string().min(1).max(120), description: z.string().max(300), hours: z.number().min(0.25).max(500) })
    .nullable()
    .describe("Only for OUT_OF_SCOPE or GRAY_ZONE work worth billing"),
});
export type ScopeCheck = z.infer<typeof ScopeCheckSchema>;
