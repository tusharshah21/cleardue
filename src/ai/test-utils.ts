import type { LanguageModelV4Content, LanguageModelV4GenerateResult } from "@ai-sdk/provider";

/** A mock model response for MockLanguageModelV4. */
export const gen = (content: LanguageModelV4Content[]): LanguageModelV4GenerateResult => ({
  content,
  finishReason: { unified: content.some((c) => c.type === "tool-call") ? "tool-calls" : "stop", raw: undefined },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
  warnings: [],
});
