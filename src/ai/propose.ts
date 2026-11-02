// proposeAction: a short tool loop. Tools are gated (src/agent/tools.ts), so this function never touches
// money itself; it only lets the model choose. Retries once, but only if no tool has run yet, so a retry
// can never double-execute an action.
import { generateText, isStepCount, type LanguageModel, type ToolSet } from "ai";
import * as prompt from "./prompts/propose-action";
import { AI_TIMEOUT_MS } from "./structured";

export interface ProposeResult {
  rationale: string;
  error?: string;
}

export async function proposeAction(
  model: LanguageModel,
  input: Parameters<typeof prompt.buildPrompt>[0],
  tools: ToolSet,
  toolCallsSoFar: () => number,
): Promise<ProposeResult> {
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await generateText({
        model,
        system: prompt.system,
        prompt: prompt.buildPrompt(input),
        tools,
        stopWhen: isStepCount(4),
        abortSignal: AbortSignal.timeout(AI_TIMEOUT_MS),
        maxRetries: 0,
      });
      return { rationale: result.text.trim() };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      if (toolCallsSoFar() > 0) break;
    }
  }
  return { rationale: "", error };
}
