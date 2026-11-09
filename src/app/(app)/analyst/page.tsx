import type { Metadata } from "next";
import { clientsFor, decisionsFor, invoicesFor, plansFor, receivablesFor } from "@/agent/analyst";
import { agLicence } from "@/lib/ag-licence";
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
  const [clients, invoices, receivables, decisions, plans] = await Promise.all([clientsFor(freelancer.id), invoicesFor(freelancer.id), receivablesFor(freelancer.id), decisionsFor(freelancer.id), plansFor(freelancer.id)]);
  const licence = agLicence(process.env.AG_STUDIO);
  return (
    <div className="space-y-3" data-tour="analyst">
      <div>
        <h1 className="text-2xl font-semibold">Collections analyst</h1>
        <p className="text-sm text-muted-foreground">Ask about receivables, mandate decisions and payment plans. Anything the analyst proposes waits on Approvals.</p>
      </div>
      {licence.state !== "ok" && (
        <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <strong>{licence.state === "missing" ? "The AG Studio licence key is not set." : `The AG Studio licence key expired on ${licence.expiry}.`}</strong> The report and the AI panel still work, with AG&apos;s trial watermark. Set a current key in <code>AG_STUDIO</code> on the server to remove this.
        </div>
      )}
      <AnalystStudio licenseKey={process.env.AG_STUDIO || undefined} clients={clients} invoices={invoices} receivables={receivables} decisions={decisions} plans={plans} />
    </div>
  );
}
