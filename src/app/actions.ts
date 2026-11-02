"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { logIn, logOut, requireFreelancer } from "@/lib/auth";
import { db } from "@/lib/db";
import { createAndSendInvoice, syncInvoice } from "@/lib/invoicing";
import { toMinor } from "@/lib/money";

export interface FormState {
  error?: string;
}

const errorText = (e: unknown) =>
  e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : e instanceof Error ? e.message : String(e);

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  const ok = await logIn(String(form.get("email") ?? ""), String(form.get("password") ?? ""));
  if (!ok) return { error: "Wrong email or password." };
  redirect("/dashboard");
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
