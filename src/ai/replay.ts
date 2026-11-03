// A LanguageModel that replays recorded responses (DEMO_MODE), so the demo video can't fail on a slow
// or failed AI call. A fixture matches when its task tag and phrase both appear in the prompt; the step
// is chosen by how many assistant turns the prompt already has (tool loops take several steps).
// `{{key}}` / `{{key.0}}` placeholders are filled from the prompt's `FACTS {...}` line, so replayed tool
// calls carry the real invoice id, dates and amounts. Unmatched prompts go to `fallthrough` unchanged.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";

export interface Fixture {
  task: string;
  match: string;
  steps: LanguageModelV4Content[][];
}

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
};

function promptText(options: LanguageModelV4CallOptions): string {
  return options.prompt
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => ("text" in p ? p.text : JSON.stringify(p))).join("\n")))
    .join("\n");
}

function fill(content: LanguageModelV4Content[], facts: Record<string, unknown>): LanguageModelV4Content[] {
  const json = JSON.stringify(content).replace(/\{\{(\w+)(?:\.(\d+))?\}\}/g, (whole, key: string, index?: string) => {
    const value = index === undefined ? facts[key] : (facts[key] as unknown[] | undefined)?.[Number(index)];
    // Escape twice: tool-call inputs are JSON strings nested inside this JSON.
    return value == null ? whole : JSON.stringify(JSON.stringify(String(value)).slice(1, -1)).slice(1, -1);
  });
  return JSON.parse(json) as LanguageModelV4Content[];
}

/** Marks a replayed step, so the UI can label it ("replayed response") instead of passing it off as live. */
const REPLAYED = { cleardue: { replayed: true } };
export const wasReplayed = (steps: { providerMetadata?: Record<string, Record<string, unknown>> | undefined }[]) =>
  steps.some((s) => s.providerMetadata?.cleardue?.replayed === true);

export function findFixture(fixtures: Fixture[], options: LanguageModelV4CallOptions): LanguageModelV4Content[] | null {
  const text = promptText(options);
  const fixture = fixtures.find((f) => text.includes(f.task) && text.includes(f.match));
  if (!fixture) return null;
  const step = options.prompt.filter((m) => m.role === "assistant").length;
  const facts = /FACTS (\{.*\})/.exec(text)?.[1];
  const content = fixture.steps[Math.min(step, fixture.steps.length - 1)];
  return facts ? fill(content, JSON.parse(facts) as Record<string, unknown>) : content;
}

export function replayModel(fixtures: Fixture[], fallthrough: LanguageModelV4): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "cleardue-replay",
    modelId: `replay(${fallthrough.modelId})`,
    supportedUrls: {},
    async doGenerate(options) {
      const content = findFixture(fixtures, options);
      if (!content) return fallthrough.doGenerate(options);
      const toolCall = content.some((c) => c.type === "tool-call");
      return { content, finishReason: { unified: toolCall ? "tool-calls" : "stop", raw: undefined }, usage, warnings: [], providerMetadata: REPLAYED };
    },
    doStream(options) {
      return fallthrough.doStream(options);
    },
  };
}

/** A rate limit (429, which Google reports as RESOURCE_EXHAUSTED) or Gemini's "high demand" overload (503 UNAVAILABLE).
 * Both clear on their own, so they are worth one retry and then the recorded response. */
export function isTransient(error: unknown): boolean {
  const e = error as { statusCode?: number; message?: string } | null;
  return e?.statusCode === 429 || e?.statusCode === 503 || /RESOURCE_EXHAUSTED|UNAVAILABLE|high demand|rate.?limit|(429|503)/i.test(e?.message ?? "");
}

const BACKOFF_MS = 4_000;

/** A spent daily quota (the free tier allows few requests a day): retrying in seconds can't help, it resets in hours. */
export const isDailyQuota = (error: unknown) => /per day|PerDay|retry in d+h/i.test((error as { message?: string } | null)?.message ?? "");

/** Seconds the provider asked us to wait, if it said (Retry-After header), capped so a request never hangs. */
function backoffFor(error: unknown): number {
  const headers = (error as { responseHeaders?: Record<string, string> }).responseHeaders;
  const seconds = Number(headers?.["retry-after"]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 10_000) : BACKOFF_MS;
}

/** Retries a rate-limited or overloaded call once after a short backoff; any other error, and a second failure, go to the caller. */
export function retryTransient(model: LanguageModelV4, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): LanguageModelV4 {
  const once = async <T>(call: () => PromiseLike<T>): Promise<T> => {
    try {
      return await call();
    } catch (e) {
      if (!isTransient(e) || isDailyQuota(e)) throw e;
      await sleep(backoffFor(e));
      return call();
    }
  };
  return {
    specificationVersion: "v4",
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate: (options) => once(() => model.doGenerate(options)),
    doStream: (options) => once(() => model.doStream(options)),
  };
}

/** Live first; when the live model is still rate-limited or overloaded, serves the recorded response for the seed stories (labelled
 * as replayed). Prompts with no recording rethrow, so the task's own readable fallback takes over. */
export function replayOnTransient(fixtures: Fixture[], live: LanguageModelV4): LanguageModelV4 {
  return {
    ...live,
    specificationVersion: "v4",
    doGenerate: async (options) => {
      try {
        return await live.doGenerate(options);
      } catch (e) {
        const content = isTransient(e) ? findFixture(fixtures, options) : null;
        if (!content) throw e;
        const toolCall = content.some((c) => c.type === "tool-call");
        return { content, finishReason: { unified: toolCall ? "tool-calls" : "stop", raw: undefined }, usage, warnings: [], providerMetadata: REPLAYED };
      }
    },
    doStream: (options) => live.doStream(options),
  };
}

/** Stands in for the live model when it isn't configured, so callers hit their fallback with a readable error. */
export function unavailableModel(reason: string): LanguageModelV4 {
  const fail = async (): Promise<never> => {
    throw new Error(`AI unavailable: ${reason}`);
  };
  return { specificationVersion: "v4", provider: "none", modelId: "unavailable", supportedUrls: {}, doGenerate: fail, doStream: fail };
}
