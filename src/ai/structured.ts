// One structured-output call with the house rules: timeout, Zod validation, retry once, then a caller-supplied fallback.
import { generateText, Output, type LanguageModel } from "ai";
import type { z } from "zod";
import { readCache, writeCache, type CacheRequest } from "./cache";
import { ANSWER_BUDGET_MS, Budget } from "./budget";
import { providerOf, wasReplayed } from "./replay";

/** Cap per model call (each task retries at most once). */
export const AI_TIMEOUT_MS = 20_000;

export interface StructuredResult<T> {
  value: T;
  /** True when both attempts failed and `value` is the fallback. */
  fallback: boolean;
  error?: string;
  /** True when DEMO_MODE served a recorded response instead of calling the model. */
  replayed?: boolean;
  /** True when an earlier live result for identical inputs was reused (demo freelancer only). */
  cached?: boolean;
  /** Which provider and model actually produced a live answer ("openai/gpt-5.4-mini"), after any failover. */
  provider?: string;
}

export async function structured<S extends z.ZodType>(opts: {
  model: LanguageModel;
  schema: S;
  system: string;
  prompt: string;
  fallback: (error: string) => z.infer<S>;
  cache?: CacheRequest;
  /** The action's overall time allowance (default 20 s); the call is abandoned, and the fallback returned, when it runs out. */
  budget?: Budget;
}): Promise<StructuredResult<z.infer<S>>> {
  if (opts.cache) {
    const hit = opts.schema.safeParse(await readCache(opts.model, opts.cache));
    if (hit.success) return { value: hit.data, fallback: false, replayed: false, cached: true };
  }
  let lastError = "";
  const budget = opts.budget ?? new Budget(ANSWER_BUDGET_MS);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (budget.exhausted()) {
      lastError = budget.exhaustedMessage;
      break;
    }
    try {
      const { output, steps } = await generateText({
        model: opts.model,
        system: opts.system,
        prompt: opts.prompt,
        output: Output.object({ schema: opts.schema }),
        abortSignal: budget.signal(AI_TIMEOUT_MS),
        maxRetries: 0,
      });
      // Output.object validates already; parse again so the return type is the schema's, not the SDK's.
      const value = opts.schema.parse(output);
      const replayed = wasReplayed(steps);
      if (opts.cache && !replayed) await writeCache(opts.model, opts.cache, value);
      return { value, fallback: false, replayed, cached: false, provider: replayed ? undefined : providerOf(steps) };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { value: opts.fallback(lastError), fallback: true, error: lastError };
}
