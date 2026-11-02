// Scoring for the reply-classification eval (npm run eval). Pure, so it is unit-tested.
import { REASONS, type Reason } from "../src/ai/schemas";

export interface EvalCase {
  id: string;
  messages: string[];
  expected: Reason;
  promisedDate?: string;
  approverEmail?: string;
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
