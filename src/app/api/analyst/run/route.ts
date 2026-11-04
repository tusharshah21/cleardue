import { isStepCount, streamText } from "ai";
import type { AgAiEvent, AgAiRunInput } from "ag-studio";
import { getModel } from "@/ai/provider";
import { analystTools } from "@/agent/analyst";
import { requireFreelancer } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

export const maxDuration = 60;

const SYSTEM = `You are ClearDue's collections analyst, working for a solo freelancer who bills overseas clients through PayPal.
Answer questions about their receivables, the mandate's decisions and payment plans, using the tools. Never guess a number: call a tool first and quote what it returns. Amounts are in each invoice's own currency; do not add different currencies together.
You can PROPOSE actions (a message to a client, a pause, a payment plan, handing a dispute to the freelancer) with the propose_ tools. A proposal never runs by itself: it goes to the freelancer's Approvals page, and the mandate may also refuse it outright. Say so plainly after proposing, report whether it was queued or blocked, and give the reason if it was blocked. Only propose something the user asked for or clearly agreed to; draft messages in the freelancer's voice, short and friendly.
Be concise: a few sentences, or a short list.`;

/** The collections analyst agent's server side: AG Studio's clientToolRunner posts the conversation here and gets AG-UI
 * events back, one JSON object per line. Claude or Gemini (the app's model) runs the tool loop on the server, where the
 * freelancer's data and the mandate gate live; the browser only sees the answer. */
export async function POST(req: Request) {
  const freelancer = await requireFreelancer();
  if (!rateLimit(`analyst:${freelancer.id}`, 20, 60_000)) return Response.json({ error: "Too many questions. Please wait a minute." }, { status: 429 });
  const input = (await req.json()) as AgAiRunInput;
  const messages = input.messages.flatMap((m) => ((m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim() ? [{ role: m.role, content: m.content }] : []));
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: AgAiEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      const id = crypto.randomUUID();
      let open = false;
      try {
        const result = streamText({
          model: getModel(),
          system: SYSTEM,
          messages,
          tools: analystTools(freelancer.id),
          stopWhen: isStepCount(6),
          abortSignal: AbortSignal.any([req.signal, AbortSignal.timeout(55_000)]),
          maxRetries: 0,
        });
        for await (const part of result.fullStream) {
          if (part.type === "text-delta" && part.text) {
            if (!open) {
              send({ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" });
              open = true;
            }
            send({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: part.text });
          } else if (part.type === "error") {
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
        }
        if (open) send({ type: "TEXT_MESSAGE_END", messageId: id });
      } catch (e) {
        if (open) send({ type: "TEXT_MESSAGE_END", messageId: id });
        send({ type: "RUN_ERROR", message: `The analyst couldn't answer: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
