// Seeded history for the analyst dashboard: a fourth client, Northwind Media, whose past is produced by running the real
// pipeline, not by writing rows. A recorded client reply is classified, the agent's three recorded proposals go through
// the mandate (one allowed, one held for approval, one blocked), the freelancer approves the held one, the client
// accepts the plan, PayPal splits the invoice, and both parts are paid. Acme, Brightside and Koala are untouched.
import { approveProposal, analyzeInvoice } from "@/agent/cases";
import { hourIn } from "@/agent/mandate";
import { DEMO_FIXTURES, NORTHWIND } from "@/ai/demo-fixtures";
import { replayModel, unavailableModel } from "@/ai/replay";
import type { Freelancer } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { createAndSendInvoice, syncInvoice } from "@/lib/invoicing";
import { fromMinor } from "@/lib/money";
import { recordPayment } from "@/paypal/invoices";
import { acceptPlan } from "@/plans/accept";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** The next time it is `hour`:00 in London. The pipeline runs "as of" then, so the client's quiet hours hold its friendly note. */
export function nextLondonHour(hour: number, from = new Date()): Date {
  const start = new Date(Math.ceil(from.getTime() / HOUR) * HOUR);
  for (let i = 0; i < 48; i++) {
    const at = new Date(start.getTime() + i * HOUR);
    if (hourIn("Europe/London", at) === hour) return at;
  }
  return start;
}

export async function seedHistory({ freelancer, clientEmail, now = new Date() }: { freelancer: Freelancer; clientEmail: string; now?: Date }) {
  const client = await db.client.create({
    data: { freelancerId: freelancer.id, email: clientEmail, name: "Northwind Media", country: "GB", currency: "GBP", timezone: "Europe/London", mandate: { autopilot: true, toneCeiling: "friendly" } },
  });
  const project = await db.project.create({
    data: {
      clientId: client.id,
      name: "Brand refresh",
      scope: `Northwind Media: Brand refresh. Scope of work.
1. Logo refresh: three concepts and one round of revisions on the chosen concept.
2. Brand guide: a one-page guide covering colour, type and logo use.
3. Social templates: six templates for Instagram and LinkedIn.
4. Out of scope: copywriting, photography, print production.
5. Payment: due 14 days from invoice, through PayPal.`,
    },
  });
  const invoice = await createAndSendInvoice({
    freelancer,
    client,
    projectId: project.id,
    items: [
      { name: "Logo refresh and brand guide", quantity: 1, unitAmountMinor: 90_000, unit: "AMOUNT" },
      { name: "Social templates", quantity: 1, unitAmountMinor: 30_000, unit: "AMOUNT" },
    ],
    invoiceDate: new Date(now.getTime() - 24 * DAY),
    dueDate: new Date(now.getTime() - 6 * DAY),
  });
  const thread = [
    { direction: "OUTBOUND" as const, daysAgo: 3, body: "Hi, a quick reminder that the brand refresh invoice was due last week. The PayPal link is below. Thanks!" },
    { direction: "INBOUND" as const, daysAgo: 1, body: "Apologies for the delay. Cash is tight at the studio this quarter, could we split it?" },
  ];
  for (const m of thread) {
    await db.message.create({
      data: {
        clientId: client.id,
        invoiceId: invoice.id,
        direction: m.direction,
        channel: m.direction === "INBOUND" ? "paste" : "outbox",
        body: m.body,
        status: m.direction === "OUTBOUND" ? "sent" : null,
        sentAt: new Date(now.getTime() - m.daysAgo * DAY),
      },
    });
  }
  if (!thread[1].body.includes(NORTHWIND)) throw new Error("The recorded Northwind reply and its fixture have drifted apart");

  // 1. Diagnose and propose, from recordings only (the fallback model refuses, so nothing live can leak in).
  const at = nextLondonHour(2, now);
  const recorded = replayModel(DEMO_FIXTURES, unavailableModel("history is generated from recordings"));
  await analyzeInvoice(invoice.id, freelancer.id, recorded, at);

  // 2. The freelancer approves the friendly note that quiet hours held (the firm one stays blocked, the plan ran on its own).
  const held = await db.proposedAction.findMany({ where: { case: { invoiceId: invoice.id }, status: "pending" } });
  for (const p of held) await approveProposal(p.id, freelancer.id);

  // 3. The client accepts the plan on the pay page; PayPal replaces the invoice with two.
  await acceptPlan(invoice.payToken, 0, at);

  // 4. Both parts get paid (recorded through the invoicing API, as the sandbox buyer's checkout needs a login).
  const parts = await db.invoice.findMany({ where: { planGroup: { originalInvoiceId: invoice.id } }, orderBy: { dueDate: "asc" } });
  for (const part of parts) {
    if (!part.paypalInvoiceId) continue;
    await recordPayment(part.paypalInvoiceId, { amount: { currency_code: part.currency, value: fromMinor(part.totalMinor, part.currency) }, method: "OTHER", payment_date: ymd(now), note: "Seeded history: paid" });
    await syncInvoice(part, "history");
  }

  // The notes the freelancer approved were sent long ago; leave nothing queued in the Outbox.
  await db.message.updateMany({ where: { clientId: client.id, status: "queued" }, data: { status: "sent", sentAt: now } });
  return `Northwind Media: invoice ${invoice.paypalInvoiceId ?? "(local)"}, plan ${parts.length} parts, ${parts.filter((p) => p.paypalInvoiceId).length} paid`;
}
