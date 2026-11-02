import Link from "next/link";
import { ProposalCard } from "@/components/proposal-card";
import { TaskDoneButton } from "./task-done-button";
import { requireFreelancer } from "@/lib/auth";
import { db } from "@/lib/db";
import { REASON_LABELS } from "@/lib/proposals";

export default async function ApprovalsPage() {
  const freelancer = await requireFreelancer();
  const where = { case: { invoice: { client: { freelancerId: freelancer.id } } } };
  const include = { case: { include: { invoice: { include: { client: true } } } } };
  const [pending, recent, tasks] = await Promise.all([
    db.proposedAction.findMany({ where: { ...where, status: "pending" }, include, orderBy: { createdAt: "asc" } }),
    db.proposedAction.findMany({ where: { ...where, status: { not: "pending" } }, include, orderBy: { createdAt: "desc" }, take: 10 }),
    db.task.findMany({ where: { done: false, invoice: { client: { freelancerId: freelancer.id } } }, include: { invoice: { include: { client: true } } }, orderBy: { createdAt: "asc" } }),
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
      {tasks.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Needs your reply</h2>
          {tasks.map((t) => (
            <div key={t.id} className="space-y-2 rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/invoices/${t.invoiceId}`} className="text-sm font-medium hover:underline">
                  {t.invoice.client.name} · {t.kind === "complaint" ? "Complaint (case in dispute)" : "Pay-page question"}
                </Link>
                <TaskDoneButton taskId={t.id} />
              </div>
              <p className="text-sm text-muted-foreground">{t.summary}</p>
              {t.detail && <blockquote className="border-l-2 pl-3 text-sm">{t.detail}</blockquote>}
            </div>
          ))}
        </section>
      )}
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
