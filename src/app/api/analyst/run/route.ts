import { isStepCount, streamText } from "ai";
import type { AgAiEvent, AgAiRunInput } from "ag-studio";
import { ANSWER_BUDGET_MS } from "@/ai/budget";
import { getModel } from "@/ai/provider";
import { providerOf } from "@/ai/replay";
import { providerName } from "@/lib/provider-name";
import { analystTools } from "@/agent/analyst";
import { requireFreelancer } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { hasForeignScript, TEMPLATE } from "@/lib/script-guard";

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
        // The answer is read to the end before it is sent, so text in another script can be caught: one fresh try (only
        // if no tool ran, so nothing is proposed twice), then a plain sentence.
        const run = async () => {
          const result = streamText({
            model: getModel(),
            system: SYSTEM,
            messages,
            tools: analystTools(freelancer.id),
            stopWhen: isStepCount(6),
            // The whole turn (steps, retries, failover) gets one allowance; running out ends it with a readable message.
            abortSignal: AbortSignal.any([req.signal, AbortSignal.timeout(ANSWER_BUDGET_MS)]),
            maxRetries: 0,
          });
          let text = "";
          for await (const part of result.fullStream) {
            if (part.type === "text-delta" && part.text) text += part.text;
            else if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
          const steps = await result.steps;
          return { text, steps, ranTools: steps.some((s) => s.toolCalls.length > 0) };
        };
        let out = await run();
        if (hasForeignScript(out.text) && !out.ranTools) out = await run();
        const clean = hasForeignScript(out.text) ? { ...out, text: TEMPLATE.analyst } : out;
        if (clean.text) {
          send({ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" });
          open = true;
          send({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: clean.text });
        }
        // Say which provider actually produced the answer (after any failover); recorded answers carry no provider.
        const provider = open ? providerOf(clean.steps) : undefined;
        if (provider) send({ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: `

(Answered by ${providerName(provider)})` });
        if (open) send({ type: "TEXT_MESSAGE_END", messageId: id });
      } catch (e) {
        if (open) send({ type: "TEXT_MESSAGE_END", messageId: id });
        const timedOut = e instanceof Error && /abort|timeout|timed out/i.test(`${e.name} ${e.message}`);
        send({ type: "RUN_ERROR", message: timedOut ? `The analyst ran out of time (${ANSWER_BUDGET_MS / 1000}s). Try a narrower question, or ask again.` : `The analyst couldn't answer: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
