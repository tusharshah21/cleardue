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
