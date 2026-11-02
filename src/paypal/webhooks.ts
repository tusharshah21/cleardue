// PayPal webhook signature verification via POST /v1/notifications/verify-webhook-signature.
import { paypalRequest } from "./client";

export const INVOICE_EVENTS = ["INVOICING.INVOICE.PAID", "INVOICING.INVOICE.UPDATED", "INVOICING.INVOICE.CANCELLED", "INVOICING.INVOICE.REFUNDED"];

export interface WebhookEventBody {
  id: string;
  event_type: string;
  resource?: { id?: string; invoice?: { id?: string } };
}

/** The invoice id an invoicing event refers to (PayPal nests it under resource.invoice for v2 invoicing). */
export const invoiceIdOf = (e: WebhookEventBody) => e.resource?.invoice?.id ?? e.resource?.id ?? null;

export async function verifyWebhookSignature(headers: Headers, event: unknown): Promise<{ verified: boolean; reason?: string }> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return { verified: false, reason: "PAYPAL_WEBHOOK_ID is not set" };
  const h = (name: string) => headers.get(name) ?? "";
  if (!h("paypal-transmission-id") || !h("paypal-transmission-sig")) return { verified: false, reason: "missing PayPal signature headers" };
  try {
    const res = await paypalRequest<{ verification_status: string }>("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: {
        auth_algo: h("paypal-auth-algo"),
        cert_url: h("paypal-cert-url"),
        transmission_id: h("paypal-transmission-id"),
        transmission_sig: h("paypal-transmission-sig"),
        transmission_time: h("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: event,
      },
    });
    return res.verification_status === "SUCCESS" ? { verified: true } : { verified: false, reason: `verification_status ${res.verification_status}` };
  } catch (e) {
    return { verified: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function createWebhook(url: string) {
  return paypalRequest<{ id: string }>("/v1/notifications/webhooks", {
    method: "POST",
    body: { url, event_types: INVOICE_EVENTS.map((name) => ({ name })) },
  });
}

export function simulateEvent(webhookId: string, eventType: string) {
  return paypalRequest<{ id: string }>("/v1/notifications/simulate-event", {
    method: "POST",
    body: { webhook_id: webhookId, event_type: eventType, resource_version: "2.0" },
  });
}
