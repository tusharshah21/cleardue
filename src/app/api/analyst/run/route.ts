import type { AgAiEvent, AgAiRunInput } from "ag-studio";
import { requireFreelancer } from "@/lib/auth";

// SPIKE (spike/ag-studio): the analyst agent's server side, answering AG Studio's clientToolRunner with one
// AG-UI event per NDJSON line. A scripted stand-in for Claude (no API key yet): the first round calls the
// custom tool `get_receivables`; once its result is in the conversation, it summarises it. The real build
// swaps this for an AI SDK stream with the same event mapping.
export async function POST(req: Request) {
  await requireFreelancer();
  const input = (await req.json()) as AgAiRunInput;
  const last = input.messages.at(-1);
  const id = crypto.randomUUID();
  const events: AgAiEvent[] =
    last?.role === "tool"
      ? [
          { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" },
          { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: summarise(last.content) },
          { type: "TEXT_MESSAGE_END", messageId: id },
        ]
      : input.tools.some((t) => t.name === "get_receivables")
        ? [
            { type: "TOOL_CALL_START", toolCallId: id, toolCallName: "get_receivables" },
            { type: "TOOL_CALL_ARGS", toolCallId: id, delta: "{}" },
            { type: "TOOL_CALL_END", toolCallId: id },
          ]
        : [{ type: "RUN_ERROR", message: "get_receivables is not offered" }];
  return new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
}

function summarise(content: string): string {
  try {
    const { data } = JSON.parse(content) as { data?: { client: string; daysOverdue: number; reason: string }[] };
    if (!data) return `ClearDue answered: ${content.slice(0, 300)}`;
    const worst = [...data].sort((a, b) => b.daysOverdue - a.daysOverdue)[0];
    return `ClearDue has ${data.length} open invoices; I've added them to the page as a grid. Most overdue: ${worst?.client} (${worst?.daysOverdue} days, ${worst?.reason}).`;
  } catch {
    return `ClearDue answered: ${content.slice(0, 300)}`;
  }
}
