import { z } from "zod";
import { analyzeInvoice, type Stage } from "@/agent/cases";
import { requireFreelancer } from "@/lib/auth";
import { db } from "@/lib/db";

const Body = z.object({ reply: z.string().trim().max(5000).optional() });

// Flow C with progress: optionally saves a pasted client reply, then diagnoses and proposes, streaming one JSON
// line per stage ({"stage":...}) and ending with {"done":true} or {"error":...}.
export async function POST(req: Request, ctx: RouteContext<"/api/invoices/[id]/diagnose">) {
  const freelancer = await requireFreelancer();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ error: "Reply is too long (5000 characters max)." }, { status: 400 });
  const invoice = await db.invoice.findFirst({ where: { id, client: { freelancerId: freelancer.id } } });
  if (!invoice) return Response.json({ error: "Invoice not found." }, { status: 404 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (v: object) => controller.enqueue(encoder.encode(`${JSON.stringify(v)}\n`));
      try {
        const reply = parsed.data.reply;
        if (reply) await db.message.create({ data: { clientId: invoice.clientId, invoiceId: id, direction: "INBOUND", channel: "paste", body: reply } });
        await analyzeInvoice(id, freelancer.id, undefined, undefined, (stage: Stage) => send({ stage }));
        send({ done: true });
      } catch (e) {
        send({ error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
