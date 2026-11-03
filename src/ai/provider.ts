// Model selection. AI_PROVIDER picks google (the default, Gemini through Google AI Studio) or anthropic (Claude);
// the model name always comes from AI_MODEL. Tasks take the model as a parameter, so tests pass a mock and never touch this.
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { DEMO_FIXTURES } from "./demo-fixtures";
import { replayModel, replayOnTransient, retryTransient, unavailableModel } from "./replay";

export type AiProvider = "google" | "anthropic";

export const aiProvider = (): AiProvider => (process.env.AI_PROVIDER === "anthropic" ? "anthropic" : "google");

export function liveModel(): LanguageModelV4 {
  const modelId = process.env.AI_MODEL;
  if (!modelId) return unavailableModel("AI_MODEL is not set");
  if (aiProvider() === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) return unavailableModel("ANTHROPIC_API_KEY is not set");
    return anthropic(modelId);
  }
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) return unavailableModel("GOOGLE_GENERATIVE_AI_API_KEY is not set");
  return google(modelId);
}

export const isDemoMode = () => process.env.DEMO_MODE === "true";

/** The live model with one backoff retry on a rate limit (429 / RESOURCE_EXHAUSTED) or an overload (503 UNAVAILABLE). If that fails too, the seed
 * stories get their recorded response (labelled "Replayed response"); anything else throws to the caller's fallback.
 * DEMO_MODE goes the other way: recorded first, live only for prompts with no recording. */
export function getModel(): LanguageModelV4 {
  const live = retryTransient(liveModel());
  return isDemoMode() ? replayModel(DEMO_FIXTURES, live) : replayOnTransient(DEMO_FIXTURES, live);
}
