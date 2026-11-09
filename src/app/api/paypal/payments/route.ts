import { requireFreelancer } from "@/lib/auth";
import { paymentsReceived } from "@/paypal/transactions";

export const dynamic = "force-dynamic";

// Payments received in the last 90 days, live from PayPal Transaction Search (cached for 5 minutes). Signed-in only.
// Always 200: a failure comes back as { ok: false, message } with a sentence the freelancer can act on.
export async function GET() {
  await requireFreelancer();
  return Response.json(await paymentsReceived(), { headers: { "Cache-Control": "private, no-store" } });
}
