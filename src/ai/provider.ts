// Model selection. AI_PROVIDER picks the primary provider (google, openai or anthropic) and AI_MODEL its model.
// AI_FALLBACK_PROVIDER and AI_FALLBACK_MODEL optionally name a secondary that takes over when the primary is rate limited,
// out of quota, down (5xx) or not configured. Tasks take the model as a parameter, so tests pass a mock and never touch this.
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import { DEMO_FIXTURES } from "./demo-fixtures";
import { failover, labelProvider, replayModel, replayOnTransient, retryTransient, unavailableModel } from "./replay";

export type AiProvider = "google" | "openai" | "anthropic";

const PROVIDERS: AiProvider[] = ["google", "openai", "anthropic"];
const KEY_VAR: Record<AiProvider, string> = { google: "GOOGLE_GENERATIVE_AI_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
const parse = (v: string | undefined): AiProvider | null => (PROVIDERS.includes(v as AiProvider) ? (v as AiProvider) : null);

export const aiProvider = (): AiProvider => parse(process.env.AI_PROVIDER) ?? "google";
/** The secondary provider, if one is configured and differs from the primary. */
export const fallbackProvider = (): AiProvider | null => {
  const p = parse(process.env.AI_FALLBACK_PROVIDER);
  return p && p !== aiProvider() ? p : null;
};
/** The env var holding the API key for a provider (named in error messages and the eval runner). */
export const keyVar = (provider: AiProvider) => KEY_VAR[provider];

/** OpenAI's reasoning models (gpt-5.x, o-series) think before answering; these tasks are short, so keep it light. */
const reasons = (modelId: string) => /^(gpt-5|o\d)/.test(modelId);

/** A labelled model for one provider, or one that fails with a readable "unavailable" if the key or model isn't set. */
export function modelFor(provider: AiProvider, modelId: string | undefined): LanguageModelV4 {
  if (!modelId) return unavailableModel(`${provider === aiProvider() ? "AI_MODEL" : "AI_FALLBACK_MODEL"} is not set`);
  if (!process.env[KEY_VAR[provider]]) return unavailableModel(`${KEY_VAR[provider]} is not set`);
  let base: LanguageModelV4;
  if (provider === "anthropic") base = anthropic(modelId);
  else if (provider === "openai") {
    const model = openai(modelId);
    base = reasons(modelId)
      ? wrapLanguageModel({ model, middleware: defaultSettingsMiddleware({ settings: { providerOptions: { openai: { reasoningEffort: process.env.OPENAI_REASONING_EFFORT || "none" } } } as never }) })
      : model;
  } else base = google(modelId);
  return labelProvider(base, `${provider}/${modelId}`);
}

/** The primary model alone (the eval runner measures each provider this way, without failover). */
export const liveModel = (): LanguageModelV4 => modelFor(aiProvider(), process.env.AI_MODEL);

export const isDemoMode = () => process.env.DEMO_MODE === "true";

/** The live model: the primary, with the secondary behind it if one is configured (a rate limit, spent quota, 5xx or missing
 * key on the primary sends the request once to the secondary, which retries once after a short backoff). If that fails too,
 * the seed stories get their recorded response (labelled "Replayed response"); anything else throws to the caller's fallback.
 * DEMO_MODE goes the other way: recorded first, live only for prompts with no recording. */
export function getModel(): LanguageModelV4 {
  const secondaryProvider = fallbackProvider();
  const live = secondaryProvider ? failover(liveModel(), retryTransient(modelFor(secondaryProvider, process.env.AI_FALLBACK_MODEL))) : retryTransient(liveModel());
  return isDemoMode() ? replayModel(DEMO_FIXTURES, live) : replayOnTransient(DEMO_FIXTURES, live);
}
