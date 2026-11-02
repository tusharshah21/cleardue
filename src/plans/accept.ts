// Plans in the app: which plans a client may accept on the pay page, and applying one through PayPal.
import type { Client, Freelancer, Invoice, Prisma } from "@/generated/prisma/client";
import { checkAction, effectiveMandate, type Instalment, type MandateContext } from "@/agent/mandate";
import { toAction } from "@/agent/tools";
import { db } from "@/lib/db";
import { newPayToken, syncInvoice } from "@/lib/invoicing";
import * as paypal from "@/paypal/invoices";
import type { LineItem } from "@/paypal/invoices";
import { executePlan, replacementDrafts, sendPending, strategyFor, suggestPlan, type PlanStore } from "./plans";

type PlanInvoice = Invoice & { client: Client & { freelancer: Freelancer } };

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;

function mandateContext(invoice: PlanInvoice, caseState: string, now: Date): MandateContext {
  const { client } = invoice;
  return {
    mandate: effectiveMandate(client.freelancer.mandate, client.mandate),
    caseState: caseState as MandateContext["caseState"],
    confidence: 1,
    now,
    clientTimezone: client.timezone,
    knownRecipients: [client.email],
    invoice: { paypalInvoiceId: invoice.paypalInvoiceId, status: invoice.status, totalMinor: invoice.totalMinor, paidMinor: invoice.paidMinor, dueDate: invoice.dueDate },
  };
}

/** Plans the client can accept: the one the freelancer approved for this invoice if any, otherwise (autopilot
 * only) deterministic plans inside the mandate. Everything is recomputed server-side; the browser only sends an index. */
export async function planOptions(invoice: PlanInvoice, now = new Date()): Promise<Instalment[][]> {
  const kase = await db.case.findUnique({ where: { invoiceId: invoice.id }, include: { actions: { where: { type: "offer_payment_plan", status: { in: ["executed", "auto_executed"] } }, orderBy: { decidedAt: "desc" }, take: 1 } } });
  const ctx = mandateContext(invoice, kase?.state ?? "open", now);
  const offered = kase?.actions[0];
  const candidates: Instalment[][] = [];
  if (offered) {
    const action = toAction("offer_payment_plan", offered.params as Record<string, unknown>, { mandate: ctx, currency: invoice.currency, approverEmail: null });
    if (action.type === "offer_plan") candidates.push(action.instalments);
  } else if (ctx.mandate.autopilot) {
    for (let n = 2; n <= ctx.mandate.maxInstalments; n++) {
      const plan = suggestPlan(invoice.totalMinor - invoice.paidMinor, ctx.mandate, invoice.dueDate, now, n);
      if (plan) candidates.push(plan);
    }
  }
  // The client choosing a plan the freelancer offered is the approval; only hard mandate limits apply here.
  return candidates.filter((instalments) => checkAction({ type: "offer_plan", instalments }, ctx).verdict !== "deny");
}

function prismaStore(groupId: string, invoice: PlanInvoice): PlanStore {
  return {
    async drafted(drafts) {
      for (const d of drafts) {
        await db.invoice.create({
          data: {
            clientId: invoice.clientId,
            projectId: invoice.projectId,
            paypalInvoiceId: d.paypalInvoiceId,
            planGroupId: groupId,
            currency: invoice.currency,
            totalMinor: d.input.items.reduce((s, i) => s + Math.round(i.quantity * i.unitAmountMinor), 0),
            dueDate: d.input.dueDate,
            items: json(d.input.items),
            note: d.input.note,
            payToken: newPayToken(),
          },
        });
      }
    },
    async sent(paypalInvoiceId, payerViewUrl) {
      await db.invoice.update({ where: { paypalInvoiceId }, data: { status: "SENT", ...(payerViewUrl && { payerViewUrl }) } });
    },
    async state(state, error) {
      await db.planGroup.update({ where: { id: groupId }, data: { state, error: error ?? null } });
      await db.timelineEvent.create({
        data: { invoiceId: invoice.id, kind: `plan_${state}`, summary: { pending_send: "Original cancelled; plan invoices still sending", active: "Payment plan is live: plan invoices sent", aborted: `Payment plan not applied: ${error}` }[state] },
      });
    },
  };
}

/** The client accepted plan option `index` on the pay page. */
export async function acceptPlan(payToken: string, index: number) {
  const invoice = await db.invoice.findUnique({ where: { payToken }, include: { client: { include: { freelancer: true } } } });
  if (!invoice) throw new Error("Invoice not found");
  if (!invoice.paypalInvoiceId) throw new Error("This invoice isn't on PayPal yet, so a plan can't be set up here. Please reply to the freelancer instead.");
  const plan = (await planOptions(invoice))[index];
  if (!plan) throw new Error("That plan is no longer available");
  const existing = await db.planGroup.findUnique({ where: { originalInvoiceId: invoice.id } });
  if (existing && existing.state !== "aborted") throw new Error("A payment plan is already in place for this invoice");

  const strategy = strategyFor(invoice.client.freelancer.country);
  const drafts = replacementDrafts(
    strategy,
    { currency: invoice.currency, invoiceNumber: invoice.invoiceNumber, items: invoice.items as unknown as LineItem[], totalMinor: invoice.totalMinor, paidMinor: invoice.paidMinor },
    plan,
    { invoicerBusinessName: invoice.client.freelancer.businessName, recipientEmail: invoice.client.email, recipientName: invoice.client.name },
  );
  const data = { strategy, state: "drafted", instalments: json(plan), error: null };
  const group = existing
    ? await db.planGroup.update({ where: { id: existing.id }, data })
    : await db.planGroup.create({ data: { originalInvoiceId: invoice.id, ...data } });
  await db.timelineEvent.create({ data: { invoiceId: invoice.id, kind: "plan_accepted", summary: `Client accepted a ${plan.length}-part plan on the pay page (${strategy.replace("_", " ")})` } });

  const result = await executePlan(invoice.paypalInvoiceId, drafts, paypal, prismaStore(group.id, invoice));
  await syncInvoice(invoice, "plan").catch(() => undefined);
  return { ...result, groupId: group.id };
}

/** Retries plan groups whose original is cancelled but whose new invoices didn't all send. Called by polling. */
export async function retryPendingPlans() {
  const groups = await db.planGroup.findMany({ where: { state: "pending_send" }, include: { invoices: { where: { status: "DRAFT" } } } });
  for (const g of groups) {
    const original = await db.invoice.findUnique({ where: { id: g.originalInvoiceId }, include: { client: { include: { freelancer: true } } } });
    if (!original) continue;
    await sendPending(g.invoices.flatMap((i) => (i.paypalInvoiceId ? [i.paypalInvoiceId] : [])), paypal, prismaStore(g.id, original));
  }
  return groups.length;
}
