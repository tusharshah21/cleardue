// Webhook helpers for the sandbox.
//   npm run paypal:webhook -- create https://your-app.onrender.com/api/webhooks/paypal
//       subscribes the 4 invoicing events; put the printed id in PAYPAL_WEBHOOK_ID
//   npm run paypal:webhook -- events
//       points the webhook in PAYPAL_WEBHOOK_ID at the current event list (after the list changed)
//   npm run paypal:webhook -- simulate INVOICING.INVOICE.PAID
//       asks PayPal's simulator to send a sample event to that webhook, to check whether
//       simulator events pass verify-webhook-signature (see the WebhookEvent row it creates)
import "dotenv/config";
import { createWebhook, setWebhookEvents, simulateEvent, WEBHOOK_EVENTS } from "../src/paypal/webhooks";

const [command, arg] = process.argv.slice(2);
if (command === "create" && arg) {
  const hook = await createWebhook(arg);
  console.log(`Created webhook ${hook.id} for ${WEBHOOK_EVENTS.join(", ")}\nSet PAYPAL_WEBHOOK_ID=${hook.id}`);
} else if (command === "events") {
  const id = process.env.PAYPAL_WEBHOOK_ID;
  if (!id) throw new Error("Set PAYPAL_WEBHOOK_ID first");
  await setWebhookEvents(id);
  console.log(`Webhook now listens for ${WEBHOOK_EVENTS.join(", ")}`);
} else if (command === "simulate") {
  const id = process.env.PAYPAL_WEBHOOK_ID;
  if (!id) throw new Error("Set PAYPAL_WEBHOOK_ID first");
  const event = await simulateEvent(id, arg ?? "INVOICING.INVOICE.PAID");
  console.log(`Simulated event ${event.id}. Check the WebhookEvent table: verified=true/false and its note.`);
} else {
  console.log("Usage: npm run paypal:webhook -- create <url> | events | simulate [event_type]");
}
