import { after } from "next/server";
import { db } from "@/lib/db";
import { handleWebhookEvent } from "@/lib/invoicing";
import { verifyWebhookSignature, type WebhookEventBody } from "@/paypal/webhooks";

// Unverified events (e.g. from PayPal's webhook simulator) are only ever processed outside production,
// and only when explicitly allowed. Either way the payload is never trusted for state: we re-read the
// invoice from PayPal, so an event can at most trigger a sync.
const allowUnverified = () => process.env.ALLOW_UNVERIFIED_WEBHOOKS === "true" && process.env.NODE_ENV !== "production";

/** Order: parse, verify the signature, drop duplicates (PayPal retries for up to 3 days), acknowledge with 2xx, then
 * sync after the response. A sync that fails leaves the event unprocessed; /api/sync retries it, so a slow or failing
 * PayPal read never turns into a 5xx and a retry storm. */
export async function POST(req: Request) {
  let event: WebhookEventBody;
  try {
    event = JSON.parse(await req.text()) as WebhookEventBody;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!event?.id || !event.event_type) return Response.json({ error: "not a PayPal event" }, { status: 400 });

  const { verified, reason } = await verifyWebhookSignature(req.headers, event);
  const bypass = !verified && allowUnverified();
  if (!verified && !bypass) {
    console.warn(`[webhook] rejected ${event.event_type} (${event.id}): ${reason}`);
    await store(event, false, `rejected: ${reason}`).catch(() => undefined);
    return Response.json({ error: "signature verification failed" }, { status: 400 });
  }

  try {
    const seen = await db.webhookEvent.findUnique({ where: { id: event.id }, select: { processed: true } });
    if (seen?.processed) return Response.json({ ok: true, duplicate: true });
    const note = verified ? null : `UNVERIFIED, processed in dev only: ${reason}`;
    const source = verified ? "webhook" : "unverified dev webhook";
    // Stored before we answer, so an acknowledged event can always be found and retried by polling.
    await store(event, verified, note);
    after(() =>
      handleWebhookEvent(event, { verified, process: true, note, source }).catch((e) => console.error(`[webhook] processing ${event.id} failed; polling will retry`, e)),
    );
    return Response.json({ ok: true });
  } catch (e) {
    // We could not even record it: a 503 asks PayPal to resend later, which is what we want here.
    console.error(`[webhook] could not record ${event.id}`, e);
    return Response.json({ error: "temporarily unavailable" }, { status: 503 });
  }
}

const store = (event: WebhookEventBody, verified: boolean, note: string | null) =>
  handleWebhookEvent(event, { verified, process: false, note, source: "webhook" });
