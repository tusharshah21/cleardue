import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { requireFreelancer } from "@/lib/auth";
import { db } from "@/lib/db";
import { MarkSentButton } from "./mark-sent-button";

export default async function OutboxPage() {
  const freelancer = await requireFreelancer();
  const messages = await db.message.findMany({
    where: { direction: "OUTBOUND", channel: "outbox", client: { freelancerId: freelancer.id } },
    include: { client: true },
    orderBy: { sentAt: "desc" },
    take: 50,
  });
  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Outbox</h1>
      <p className="text-sm text-muted-foreground">
        Emails the agent wrote for you. PayPal itself delivers invoices and reminders; these are the personal notes around them.
      </p>
      {messages.length === 0 && <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">No outgoing messages yet.</p>}
      {messages.map((m) => (
        <article key={m.id} className="space-y-2 rounded-lg border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div>
              <span className="font-medium">{m.subject ?? "(no subject)"}</span>
              <span className="text-muted-foreground">
                {" "}
                to {m.toAddr ?? m.client.email} ·{" "}
                {m.invoiceId ? (
                  <Link href={`/invoices/${m.invoiceId}`} className="hover:underline">
                    {m.client.name}
                  </Link>
                ) : (
                  m.client.name
                )}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={m.status === "queued" ? "secondary" : "outline"}>{m.status}</Badge>
              {m.status === "queued" && <MarkSentButton messageId={m.id} />}
            </div>
          </div>
          <p className="text-sm whitespace-pre-wrap">{m.body}</p>
        </article>
      ))}
    </div>
  );
}
