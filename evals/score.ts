// Scoring for the reply-classification eval (npm run eval). Pure, so it is unit-tested.
import { REASONS, type Reason } from "../src/ai/schemas";

/** evals/<set>.json. synthetic: written for the reasons as defined; synthetic-india: written for Indian cross-border freelancers
 * (overseas clients, Indian business English), reviewed by an India-based author; real: anonymized client replies. */
export const EVAL_SETS = ["synthetic", "synthetic-india", "real"] as const;

export interface EvalCase {
  id: string;
  messages: string[];
  /** The day the reply was sent (YYYY-MM-DD), for resolving relative dates; defaults to the set's today. */
  today?: string;
  expected: Reason;
  promisedDate?: string;
  approverEmail?: string;
  /** Who replied and what is owed, so the prompt sees what a real case would (the default is a generic USD 2400.00 invoice). */
  client?: { name: string; country: string; currency: string; amount: string; days_overdue: number };
  note?: string;
}

export interface EvalResult {
  id: string;
  expected: Reason;
  got: Reason;
  confidence: number;
  fallback: boolean;
  promisedDate?: string;
  gotDate: string | null;
}

export function score(results: EvalResult[]) {
  const perReason = REASONS.map((reason) => {
    const rows = results.filter((r) => r.expected === reason);
    return { reason, n: rows.length, correct: rows.filter((r) => r.got === reason).length };
  }).filter((r) => r.n > 0);
  const dated = results.filter((r) => r.promisedDate);
  return {
    total: results.length,
    correct: results.filter((r) => r.got === r.expected).length,
    fallbacks: results.filter((r) => r.fallback).length,
    perReason,
    dates: { n: dated.length, correct: dated.filter((r) => r.gotDate === r.promisedDate).length },
    misses: results.filter((r) => r.got !== r.expected),
  };
}
