import type { Metadata } from "next";
import { decisionsFor, plansFor, receivablesFor } from "@/agent/analyst";
import { requireFreelancer } from "@/lib/auth";
import { AnalystStudio } from "./analyst-studio";

export const metadata: Metadata = { title: "Analyst" };
export const dynamic = "force-dynamic";

// The collections analyst dashboard (AG Studio). The data is read server-side for the signed-in freelancer; the
// agent behind the AI panel runs in /api/analyst/run.
export default async function AnalystPage() {
  const freelancer = await requireFreelancer();
  const [receivables, decisions, plans] = await Promise.all([receivablesFor(freelancer.id), decisionsFor(freelancer.id), plansFor(freelancer.id)]);
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-semibold">Collections analyst</h1>
        <p className="text-sm text-muted-foreground">Ask about receivables, mandate decisions and payment plans. Anything the analyst proposes waits on Approvals.</p>
      </div>
      <AnalystStudio receivables={receivables} decisions={decisions} plans={plans} />
    </div>
  );
}
