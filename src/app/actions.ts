"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { approveProposal, rejectProposal } from "@/agent/cases";
import { MandateSchema } from "@/agent/mandate";
import { logIn, logOut, requireFreelancer } from "@/lib/auth";
import { db } from "@/lib/db";
import { cacheScopeFor } from "@/ai/cache";
import { demoEmail, manualResetWait, resetDemo, resetViaPayPal } from "@/lib/demo-seed";
import { getModel } from "@/ai/provider";
import type { ScopeCheck } from "@/ai/schemas";
import { scopeCheck } from "@/ai/tasks";
import { randomUUID } from "node:crypto";
import { addLineToDraft, createAndSendInvoice, handleWebhookEvent, sendDraft, syncInvoice } from "@/lib/invoicing";
import { isMockMode } from "@/paypal/client";
import { recordPayment } from "@/paypal/invoices";
import { mockInvoice } from "@/paypal/mock";
import { toMinor } from "@/lib/money";
import { acceptPlan } from "@/plans/accept";

export interface FormState {
  error?: string;
}

function errorText(e: unknown): string {
  if (e instanceof z.ZodError) return e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  // Database internals are for the logs, not the screen.
  if (e instanceof Error && e.constructor.name.startsWith("PrismaClient")) {
    console.error(e);
    return "Something went wrong saving this. Check the server logs.";
  }
  const message = e instanceof Error ? e.message : String(e);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  const ok = await logIn(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
  if (!ok) return { error: "Wrong email or password." };
  redirect((await cookies()).get(WELCOME_DISMISSED)?.value ? "/dashboard" : "/welcome");
}

const WELCOME_DISMISSED = "cleardue_welcome_dismissed";

/** Stop opening Start here after sign-in (it stays in the menu). */
export async function dismissWelcomeAction() {
  (await cookies()).set(WELCOME_DISMISSED, "1", { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365, path: "/" });
  redirect("/dashboard");
}

/** Start here: put the three demo stories back to their starting point. Only the demo freelancer can do this. */
export async function resetDemoAction(): Promise<FormState & { done?: boolean; notice?: string }> {
  const freelancer = await requireFreelancer();
  if (freelancer.email !== demoEmail()) return { error: "Only the demo account can be reset." };
  const wait = await manualResetWait();
  if (wait) return { notice: `The demo was reset a moment ago, so the stories should already be at the start. You can reset it again in ${wait} minute${wait === 1 ? "" : "s"}.` };
  try {
    await resetDemo({ withPayPal: resetViaPayPal() });
  } catch (e) {
    return { error: errorText(e) };
  }
  revalidatePath("/", "layout");
  return { done: true };
}

export async function logoutAction() {
  await logOut();
  redirect("/login");
}

const ClientInput = z.object({
  name: z.string().trim().min(1),
  email: z.email(),
  approverEmail: z.union([z.literal(""), z.email()]),
  country: z.string().trim().length(2).toUpperCase(),
  currency: z.string().trim().length(3).toUpperCase(),
  timezone: z.string().trim().refine((tz) => Intl.supportedValuesOf("timeZone").includes(tz), "unknown IANA timezone"),
  projectName: z.string().trim().min(1),
  scope: z.string().trim().min(20, "paste the agreed scope (at least a few sentences)"),
});

export async function createClientAction(_: FormState, form: FormData): Promise<FormState> {
  const freelancer = await requireFreelancer();
  try {
    const input = ClientInput.parse(Object.fromEntries(form));
    await db.client.create({
      data: {
        freelancerId: freelancer.id,
        name: input.name,
        email: input.email,
        approverEmail: input.approverEmail || null,
        country: input.country,
        currency: input.currency,
        timezone: input.timezone,
        projects: { create: { name: input.projectName, scope: input.scope } },
      },
    });
  } catch (e) {
    return { error: errorText(e) };
  }
  revalidatePath("/clients");
  return {};
}

const InvoiceInput = z.object({
  projectId: z.string().min(1, "pick a project"),
  dueDate: z.iso.date(),
  note: z.string().trim().max(4000).optional(),
  items: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        quantity: z.coerce.number().positive().max(10_000),
        unitAmount: z.string().trim().min(1),
        unit: z.enum(["HOURS", "AMOUNT"]),
      }),
    )
    .min(1),
});

export async function createInvoiceAction(_: FormState, form: FormData): Promise<FormState> {
  const freelancer = await requireFreelancer();
  let invoiceId: string;
  try {
    const input = InvoiceInput.parse({
      projectId: form.get("projectId"),
      dueDate: form.get("dueDate"),
      note: form.get("note") || undefined,
      items: JSON.parse(String(form.get("items") ?? "[]")),
    });
    const project = await db.project.findFirst({
      where: { id: input.projectId, client: { freelancerId: freelancer.id } },
      include: { client: true },
    });
    if (!project) return { error: "Project not found." };
    const invoice = await createAndSendInvoice({
      freelancer,
      client: project.client,
      projectId: project.id,
      dueDate: new Date(`${input.dueDate}T00:00:00Z`),
      note: input.note,
      items: input.items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        unit: i.unit,
        unitAmountMinor: toMinor(i.unitAmount, project.client.currency),
      })),
    });
    invoiceId = invoice.id;
  } catch (e) {
    return { error: `Could not create the invoice. ${errorText(e)}` };
  }
  redirect(`/invoices/${invoiceId}`);
}

export async function syncInvoiceAction(invoiceId: string): Promise<FormState> {
  const freelancer = await requireFreelancer();
  const invoice = await db.invoice.findFirst({ where: { id: invoiceId, client: { freelancerId: freelancer.id } } });
  if (!invoice) return { error: "Invoice not found." };
  try {
    await syncInvoice(invoice);
  } catch (e) {
    return { error: `Sync failed. ${errorText(e)}` };
  }
  revalidatePath(`/invoices/${invoiceId}`);
  return {};
}

export async function decideProposalAction(proposalId: string, _: FormState, form: FormData): Promise<FormState> {
  const freelancer = await requireFreelancer();
  try {
    if (form.get("decision") === "reject") await rejectProposal(proposalId, freelancer.id);
    else {
      const draft = form.get("draft");
      await approveProposal(proposalId, freelancer.id, typeof draft === "string" ? draft.slice(0, 4000) : undefined);
    }
  } catch (e) {
    return { error: errorText(e) };
  }
  revalidatePath("/", "layout");
  return {};
}

/** Public (pay page): the pay token is the credential, and the plan is looked up server-side by index. */
export async function acceptPlanAction(payToken: string, index: number): Promise<FormState> {
  try {
    const r = await acceptPlan(payToken, index);
    if (r.state === "pending_send") return { error: "Your plan is set up. One of the new invoices is still being sent; it will arrive shortly." };
  } catch (e) {
    return { error: errorText(e) };
  }
  revalidatePath(`/pay/${payToken}`);
  return {};
}

export type ScopeState = FormState & { result?: ScopeCheck; request?: string; rate?: string; replayed?: boolean; cached?: boolean; provider?: string };

/** Flow B: is this new request covered by the project's scope? */
export async function scopeCheckAction(projectId: string, _: ScopeState, form: FormData): Promise<ScopeState> {
  const freelancer = await requireFreelancer();
  const request = String(form.get("request") ?? "").trim().slice(0, 2000);
  if (!request) return { error: "Describe what the client is asking for." };
  const project = await db.project.findFirst({ where: { id: projectId, client: { freelancerId: freelancer.id } } });
  if (!project) return { error: "Project not found." };
  const { value, replayed, cached, provider } = await scopeCheck(getModel(), { scope: project.scope, request, cacheScope: await cacheScopeFor(freelancer) });
  // A rate stated in the scope ("USD 45/hour") pre-fills the line item.
  const rate = /(\d+(?:\.\d{1,2})?)\s*\/\s*h(?:ou)?r/i.exec(project.scope)?.[1];
  return { result: value, request, rate, replayed, cached, provider };
}

const LineInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(300),
  hours: z.coerce.number().positive().max(500),
  rate: z.string().trim().min(1, "set an hourly rate"),
});

export async function addLineAction(projectId: string, _: FormState, form: FormData): Promise<FormState> {
  const freelancer = await requireFreelancer();
  let invoiceId: string;
  try {
    const input = LineInput.parse(Object.fromEntries(form));
    const project = await db.project.findFirst({ where: { id: projectId, client: { freelancerId: freelancer.id } }, include: { client: true } });
    if (!project) return { error: "Project not found." };
    const r = await addLineToDraft(freelancer, project.client, project.id, {
      name: input.name,
      ...(input.description && { description: input.description }),
      quantity: input.hours,
      unitAmountMinor: toMinor(input.rate, project.client.currency),
      unit: "HOURS",
    });
    invoiceId = r.invoiceId;
  } catch (e) {
    return { error: errorText(e) };
  }
  redirect(`/invoices/${invoiceId}`);
}

export async function sendDraftAction(invoiceId: string): Promise<FormState> {
  const freelancer = await requireFreelancer();
  const invoice = await db.invoice.findFirst({ where: { id: invoiceId, status: "DRAFT", client: { freelancerId: freelancer.id } }, include: { client: true } });
  if (!invoice) return { error: "Draft not found." };
  try {
    await sendDraft(invoice, freelancer, invoice.client);
  } catch (e) {
    return { error: `Could not send. ${errorText(e)}` };
  }
  revalidatePath(`/invoices/${invoiceId}`);
  return {};
}

/** Per-client mandate. Stored as a full override so the client's limits don't shift when the default changes. */
export async function saveMandateAction(clientId: string, _: FormState & { saved?: boolean }, form: FormData): Promise<FormState & { saved?: boolean }> {
  const freelancer = await requireFreelancer();
  const client = await db.client.findFirst({ where: { id: clientId, freelancerId: freelancer.id } });
  if (!client) return { error: "Client not found." };
  try {
    const value = String(form.get("minFirstValue") ?? "").trim();
    const mandate = MandateSchema.parse({
      autopilot: form.get("autopilot") === "on",
      neverAutoContact: form.get("neverAutoContact") === "on",
      minConfidence: Number(form.get("minConfidence")),
      toneCeiling: form.get("toneCeiling"),
      maxInstalments: Number(form.get("maxInstalments")),
      minFirstPayment:
        form.get("minFirstKind") === "amount" ? { kind: "amount", valueMinor: toMinor(value, client.currency) } : { kind: "percent", value: Number(value) },
      maxPlanDays: Number(form.get("maxPlanDays")),
      quietHours: { start: Number(form.get("quietStart")), end: Number(form.get("quietEnd")) },
    });
    await db.client.update({ where: { id: client.id }, data: { mandate } });
  } catch (e) {
    return { error: errorText(e) };
  }
  revalidatePath("/clients");
  return { saved: true };
}

/** PAYPAL_MODE=mock only: the client pays in full on the mock PayPal page, then the same handler as a verified
 * INVOICING.INVOICE.PAID webhook runs. Public like the pay page; refused outside mock mode. */
export async function simulatePaymentAction(paypalInvoiceId: string): Promise<FormState> {
  try {
    if (!isMockMode()) return { error: "Only available in PayPal mock mode." };
    const inv = mockInvoice(paypalInvoiceId);
    if (!inv) return { error: "Invoice not found in the PayPal mock." };
    if (Number(inv.due_amount.value) <= 0) return { error: `Nothing due: invoice is ${inv.status}.` };
    await recordPayment(paypalInvoiceId, { amount: inv.due_amount, method: "PAYPAL", payment_date: new Date().toISOString().slice(0, 10) });
    const event = { id: `WH-MOCK-${randomUUID()}`, event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: paypalInvoiceId } } };
    const ok = await handleWebhookEvent(event, { verified: true, process: true, note: "simulated client payment (PayPal mock mode)", source: "simulated webhook" });
    if (!ok) return { error: "Payment recorded, but syncing the invoice failed. Polling will retry." };
  } catch (e) {
    return { error: errorText(e) };
  }
  revalidatePath("/", "layout");
  return {};
}

export async function completeTaskAction(taskId: string): Promise<FormState> {
  const freelancer = await requireFreelancer();
  const updated = await db.task.updateMany({ where: { id: taskId, done: false, invoice: { client: { freelancerId: freelancer.id } } }, data: { done: true } });
  if (!updated.count) return { error: "Task not found or already handled." };
  revalidatePath("/", "layout");
  return {};
}

export async function markSentAction(messageId: string): Promise<FormState> {
  const freelancer = await requireFreelancer();
  const updated = await db.message.updateMany({
    where: { id: messageId, direction: "OUTBOUND", status: "queued", client: { freelancerId: freelancer.id } },
    data: { status: "sent", sentAt: new Date() },
  });
  if (!updated.count) return { error: "Message not found or already sent." };
  revalidatePath("/outbox");
  return {};
}