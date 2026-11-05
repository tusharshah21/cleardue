// A pending proposal that something else made moot (a re-diagnosis, a complaint, the invoice being closed or replaced by
// the client's accepted plan) is "superseded", not "rejected": the freelancer never rejected it.
import { db } from "@/lib/db";
import { describeProposal } from "@/lib/proposals";

export async function supersedePending(caseId: string, invoiceId: string, why: string): Promise<number> {
  const pending = await db.proposedAction.findMany({ where: { caseId, status: "pending" } });
  if (!pending.length) return 0;
  await db.proposedAction.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { status: "superseded", decidedAt: new Date(), result: { superseded: why } } });
  for (const p of pending) {
    await db.timelineEvent.create({
      data: { invoiceId, caseId, kind: "action_superseded", summary: `Superseded: ${describeProposal(p.type, p.params as Record<string, unknown>).title} (${why})` },
    });
  }
  return pending.length;
}
