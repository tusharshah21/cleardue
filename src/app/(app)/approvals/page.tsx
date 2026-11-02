import { ProposalCard } from "@/components/proposal-card";
import { requireFreelancer } from "@/lib/auth";
import { db } from "@/lib/db";
import { REASON_LABELS } from "@/lib/proposals";

export default async function ApprovalsPage() {
  const freelancer = await requireFreelancer();
  const where = { case: { invoice: { client: { freelancerId: freelancer.id } } } };
  const include = { case: { include: { invoice: { include: { client: true } } } } };
  const [pending, recent] = await Promise.all([
    db.proposedAction.findMany({ where: { ...where, status: "pending" }, include, orderBy: { createdAt: "asc" } }),
    db.proposedAction.findMany({ where: { ...where, status: { not: "pending" } }, include, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);
  const view = (a: (typeof pending)[number]) => ({
    id: a.id,
    type: a.type,
    status: a.status,
    mandateVerdict: a.mandateVerdict,
    mandateReasons: a.mandateReasons as string[],
    draft: a.draft,
    params: a.params as Record<string, unknown>,
    result: a.result,
    context: {
      label: `${a.case.invoice.client.name} · ${REASON_LABELS[a.case.reason ?? "other"]}`,
      href: `/invoices/${a.case.invoiceId}`,
    },
  });

  return (
    <div className="max-w-3xl space-y-8">
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold">Approval queue</h1>
        <p className="text-sm text-muted-foreground">
          The agent proposes; your mandate decides what may run on its own. Everything else waits here.
        </p>
        {pending.length === 0 && <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">Nothing waiting for you.</p>}
        {pending.map((a) => (
          <ProposalCard key={a.id} p={view(a)} />
        ))}
      </section>
      {recent.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Recent decisions</h2>
          {recent.map((a) => (
            <ProposalCard key={a.id} p={view(a)} />
          ))}
        </section>
      )}
    </div>
  );
}
