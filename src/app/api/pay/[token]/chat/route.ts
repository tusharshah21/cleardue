import { z } from "zod";
import { askPayer, loadPayInvoice } from "@/agent/payer";
import { MAX_QUESTION } from "@/ai/schemas";
import { rateLimit } from "@/lib/rate-limit";

const Body = z.object({ question: z.string().trim().min(1, "Type a question").max(MAX_QUESTION, `Keep it under ${MAX_QUESTION} characters`) });

// Public endpoint (the pay link is the only credential): capped length, and limited per link and per IP.
export async function POST(req: Request, ctx: RouteContext<"/api/pay/[token]/chat">) {
  const { token } = await ctx.params;
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!rateLimit(`pay:${token}`, 10, 60_000) || !rateLimit(`ip:${ip}`, 30, 60_000)) {
    return Response.json({ error: "Too many questions. Please wait a minute and try again." }, { status: 429 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid question" }, { status: 400 });
  if (!(await loadPayInvoice(token))) return Response.json({ error: "Invoice not found" }, { status: 404 });
  try {
    return Response.json(await askPayer(token, parsed.data.question));
  } catch (e) {
    console.error("pay chat failed", e);
    return Response.json({ error: "Something went wrong. Your question was not sent; please try again." }, { status: 500 });
  }
}
