// Model selection. The model name always comes from AI_MODEL. Tasks take the model as a parameter,
// so tests pass a mock and never touch this.
import { anthropic } from "@ai-sdk/anthropic";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { DEMO_FIXTURES } from "./demo-fixtures";
import { replayModel, unavailableModel } from "./replay";

function liveModel(): LanguageModelV4 {
  const modelId = process.env.AI_MODEL;
  if (!modelId) return unavailableModel("AI_MODEL is not set");
  if (!process.env.ANTHROPIC_API_KEY) return unavailableModel("ANTHROPIC_API_KEY is not set");
  return anthropic(modelId);
}

export const isDemoMode = () => process.env.DEMO_MODE === "true";

export function getModel(): LanguageModelV4 {
  const live = liveModel();
  return isDemoMode() ? replayModel(DEMO_FIXTURES, live) : live;
}
