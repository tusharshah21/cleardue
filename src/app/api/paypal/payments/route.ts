import { requireFreelancer } from "@/lib/auth";
import { livePaymentsEnabled, paymentsReceived } from "@/paypal/transactions";

export const dynamic = "force-dynamic";

// Payments received in the last 90 days, live from PayPal Transaction Search (cached for 5 minutes). Signed-in only.
// Always 200: a failure comes back as { ok: false, message } with a sentence the freelancer can act on. 404 while
// LIVE_PAYPAL_PAYMENTS is off.
export async function GET() {
  await requireFreelancer();
  if (!livePaymentsEnabled()) return Response.json({ error: "Live PayPal payments are switched off (LIVE_PAYPAL_PAYMENTS)." }, { status: 404 });
  return Response.json(await paymentsReceived(), { headers: { "Cache-Control": "private, no-store" } });
}
