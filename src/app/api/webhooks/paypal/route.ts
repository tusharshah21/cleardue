import { db } from "@/lib/db";
import { handleWebhookEvent } from "@/lib/invoicing";
import { verifyWebhookSignature, type WebhookEventBody } from "@/paypal/webhooks";

// Unverified events (e.g. from PayPal's webhook simulator) are only ever processed outside production,
// and only when explicitly allowed. Either way the payload is never trusted for state: we re-read the
// invoice from PayPal, so an event can at most trigger a sync.
const allowUnverified = () => process.env.ALLOW_UNVERIFIED_WEBHOOKS === "true" && process.env.NODE_ENV !== "production";

export async function POST(req: Request) {
  let event: WebhookEventBody;
  try {
    event = JSON.parse(await req.text()) as WebhookEventBody;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!event?.id || !event.event_type) return Response.json({ error: "not a PayPal event" }, { status: 400 });

  const seen = await db.webhookEvent.findUnique({ where: { id: event.id } });
  if (seen?.processed) return Response.json({ ok: true, duplicate: true });

  const { verified, reason } = await verifyWebhookSignature(req.headers, event);
  const bypass = !verified && allowUnverified();
  const note = verified ? null : bypass ? `UNVERIFIED, processed in dev only: ${reason}` : `rejected: ${reason}`;
  const ok = await handleWebhookEvent(event, { verified, process: verified || bypass, note, source: verified ? "webhook" : "unverified dev webhook" });
  if (!verified && !bypass) return Response.json({ error: "signature verification failed" }, { status: 400 });
  // A failed sync leaves the event unprocessed so PayPal's retry (or polling) picks it up.
  return ok ? Response.json({ ok: true }) : Response.json({ error: "sync failed" }, { status: 500 });
}
