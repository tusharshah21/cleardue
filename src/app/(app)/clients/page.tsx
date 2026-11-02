import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireFreelancer } from "@/lib/auth";
import { db } from "@/lib/db";
import { NewClientForm } from "./new-client-form";

export default async function ClientsPage() {
  const freelancer = await requireFreelancer();
  const clients = await db.client.findMany({
    where: { freelancerId: freelancer.id },
    include: { projects: true, _count: { select: { invoices: true } } },
    orderBy: { createdAt: "asc" },
  });
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">Clients</h1>
        {clients.length === 0 && <p className="text-sm text-muted-foreground">No clients yet. Add your first one.</p>}
        {clients.map((c) => (
          <Card key={c.id}>
            <CardHeader>
              <CardTitle>{c.name}</CardTitle>
              <CardDescription>
                {c.email}
                {c.approverEmail && ` · AP: ${c.approverEmail}`} · {c.country} · {c.currency} · {c.timezone} ·{" "}
                {c._count.invoices} invoices
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {c.projects.map((p) => (
                <details key={p.id} className="rounded-md border p-3">
                  <summary className="cursor-pointer text-sm font-medium">Scope of record: {p.name}</summary>
                  <pre className="mt-2 text-xs whitespace-pre-wrap text-muted-foreground">{p.scope}</pre>
                </details>
              ))}
            </CardContent>
          </Card>
        ))}
      </section>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Add a client</CardTitle>
          <CardDescription>Paste the agreed proposal or SOW. ClearDue treats it as the scope of record.</CardDescription>
        </CardHeader>
        <CardContent>
          <NewClientForm />
        </CardContent>
      </Card>
    </div>
  );
}
