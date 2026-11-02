import Link from "next/link";
import { requireFreelancer } from "@/lib/auth";
import { db } from "@/lib/db";
import { NewInvoiceForm } from "./new-invoice-form";

export default async function NewInvoicePage() {
  const freelancer = await requireFreelancer();
  const projects = await db.project.findMany({
    where: { client: { freelancerId: freelancer.id } },
    include: { client: true },
    orderBy: { createdAt: "asc" },
  });
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">New invoice</h1>
      {projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <Link href="/clients" className="underline">Add a client and project</Link> first.
        </p>
      ) : (
        <NewInvoiceForm
          projects={projects.map((p) => ({ id: p.id, label: `${p.client.name}: ${p.name}`, currency: p.client.currency }))}
        />
      )}
    </div>
  );
}
