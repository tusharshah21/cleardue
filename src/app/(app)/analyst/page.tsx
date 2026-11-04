import type { Metadata } from "next";
import { decisionsFor, plansFor, receivablesFor } from "@/agent/analyst";
import { requireFreelancer } from "@/lib/auth";
import { AnalystStudio } from "./analyst-studio";

export const metadata: Metadata = { title: "Analyst" };
export const dynamic = "force-dynamic";

// The collections analyst dashboard (AG Studio). The data is read server-side for the signed-in freelancer; the
// agent behind the AI panel runs in /api/analyst/run. The AG Studio licence key (AG_STUDIO) is a client-side key by
// design: it is read here and handed only to this page's component, so it reaches the browser on /analyst alone, for
// signed-in users, and is never logged or put in a NEXT_PUBLIC variable (which would ship it in every bundle).
export default async function AnalystPage() {
  const freelancer = await requireFreelancer();
  const [receivables, decisions, plans] = await Promise.all([receivablesFor(freelancer.id), decisionsFor(freelancer.id), plansFor(freelancer.id)]);
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-2xl font-semibold">Collections analyst</h1>
        <p className="text-sm text-muted-foreground">Ask about receivables, mandate decisions and payment plans. Anything the analyst proposes waits on Approvals.</p>
      </div>
      <AnalystStudio licenseKey={process.env.AG_STUDIO || undefined} receivables={receivables} decisions={decisions} plans={plans} />
    </div>
  );
}
