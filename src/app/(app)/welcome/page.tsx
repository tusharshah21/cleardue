import type { Metadata } from "next";
import Link from "next/link";
import { dismissWelcomeAction } from "@/app/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { requireFreelancer } from "@/lib/auth";
import { effectiveMandate, inQuietHours } from "@/agent/mandate";
import { db } from "@/lib/db";
import { ago, readTimes } from "@/lib/app-state";
import { nextScheduledReset } from "@/lib/demo-seed";
import { checkPayPalAuth } from "@/paypal/client";
import { LocalTime } from "./local-time";
import { ResetDemo } from "./reset-demo";

export const metadata: Metadata = { title: "Start here" };

// The three seeded stories, each linked straight to the screen where it happens. A story whose client isn't in
// the database (a fresh account) is simply not shown.
const STORIES = [
  {
    client: "Acme Labs",
    title: "Autopilot acts, no click",
    body: "Dana is waiting on finance. Click Diagnose now: the agent sends a PayPal reminder to Acme's AP contact and pauses reminders, inside Aarav's mandate, with nobody approving.",
    cta: "Open Acme's invoice",
    target: "invoice",
  },
  {
    client: "Brightside Studio",
    title: "Approval path and a payment plan",
    body: "Sam is short on cash. Diagnose it, open Sam's pay page and accept a plan. Autopilot is off here, so it waits on Approvals; once approved, PayPal gets two smaller invoices.",
    cta: "Open Brightside's invoice",
    target: "invoice",
    extra: "Open Sam's pay page",
  },
  {
    client: "Koala Digital",
    title: "The client's pay page",
    body: "What the client sees: answers grounded in the scope with quotes, a plan on request, and a discount request passed to Aarav. Paying closes the invoice and its tasks.",
    cta: "Open Koala's pay page",
    target: "pay",
  },
] as const;

const ANALYST = {
  client: "Analyst",
  title: "Ask the analyst",
  body: "Ask in plain English, answered from the live data through the same mandate. Try: \"Who owes me money, and what should I do first?\" Anything it proposes lands in Approvals; it never sends on its own.",
  cta: "Ask the analyst",
  href: "/analyst",
};

const ACME_NIGHT =
  "It's night in New York, so Aarav's mandate holds client contact until morning (quiet hours). The diagnosis still runs and the reminder waits in Approvals. Try Koala for an autopilot plan, or come back during New York daytime.";

export default async function WelcomePage() {
  const freelancer = await requireFreelancer();
  const invoices = await db.invoice.findMany({
    where: { client: { freelancerId: freelancer.id, name: { in: STORIES.map((s) => s.client) } }, planGroupId: null },
    include: { client: true, case: true },
    orderBy: { createdAt: "asc" },
  });
  const plans = await db.planGroup.findMany({ where: { originalInvoiceId: { in: invoices.map((i) => i.id) } }, select: { originalInvoiceId: true } });
  const now = new Date();
  const { lastScheduledSyncAt } = await readTimes();
  const paypal = await checkPayPalAuth();
  const stories = STORIES.flatMap((s) => {
    const invoice = invoices.find((i) => i.client.name === s.client);
    if (!invoice) return [];
    const href = s.target === "pay" ? `/pay/${invoice.payToken}` : `/invoices/${invoice.id}`;
    // Acme's autopilot reminder is client contact, which the mandate holds during the client's quiet hours.
    const quiet = s.client === "Acme Labs" && inQuietHours(effectiveMandate(freelancer.mandate, invoice.client.mandate).quietHours, invoice.client.timezone, now);
    // A story someone has already played through: Acme diagnosed, Brightside on a plan (or closed), Koala paid.
    const paid = invoice.status === "PAID" || invoice.status === "MARKED_AS_PAID";
    const played = s.client === "Acme Labs" ? !!invoice.case || paid : s.client === "Brightside Studio" ? plans.some((p) => p.originalInvoiceId === invoice.id) || paid || invoice.status === "CANCELLED" : paid;
    const extraHref = "extra" in s ? `/pay/${invoice.payToken}` : undefined;
    return [{ ...s, ...(quiet && !played ? { title: "Quiet hours: the reminder waits", body: ACME_NIGHT } : {}), href, extraHref, played }];
  });

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">Start here</p>
        <h1 className="text-2xl font-semibold text-balance">91% of surveyed New York freelancers have been paid late at least once. ClearDue finds out why each client hasn&apos;t paid and acts on it through PayPal, inside limits the freelancer sets.</h1>
        <p className="text-muted-foreground">You&apos;re signed in as {freelancer.name}, a designer in India with three overseas clients. Each story below takes a minute, and the analyst is there to ask.</p>
      </div>

      {!paypal.ok && paypal.problem !== "unreachable" && (
        <p role="alert" className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          PayPal is rejecting the sandbox credentials this app uses ({paypal.error}). Invoices, reminders and payments will fail until they are replaced in the server settings.
        </p>
      )}

      {stories.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[...stories, { ...ANALYST, target: "app" as const, played: false, extraHref: undefined, extra: undefined }].map((s, n) => (
            <Card key={s.client} className="flex flex-col">
              <CardHeader>
                <CardDescription>
                  {n + 1}. {s.client}
                </CardDescription>
                <CardTitle>{s.title}</CardTitle>
              </CardHeader>
              <CardContent className="flex-1 space-y-2 text-sm text-muted-foreground">
                {s.played && <p className="rounded-md bg-muted p-2 font-medium text-foreground">Already played. Click Reset demo to replay it.</p>}
                <p>{s.body}</p>
              </CardContent>
              <CardFooter className="flex-col gap-2">
                <Link href={s.href} className={buttonVariants({ variant: n === 0 ? "default" : "outline", className: "w-full" })} {...(s.target === "pay" && { target: "_blank", rel: "noopener" })}>
                  {s.cta}
                </Link>
                {s.extraHref && (
                  <Link href={s.extraHref} target="_blank" rel="noopener" className={buttonVariants({ variant: "ghost", className: "w-full" })}>
                    {(s as { extra?: string }).extra}
                  </Link>
                )}
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">The demo stories aren&apos;t in this database yet. Click <strong>Reset demo</strong> below to create them (or run <code>npm run seed</code>).</p>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-lg border p-4">
        <div className="flex-1 text-sm text-muted-foreground">
          <p>Demo resets daily. Use Reset demo if a story is already finished.</p>
          <p className="text-xs">
            Next automatic reset: <LocalTime iso={nextScheduledReset(now).toISOString()} />. Last automatic sync: {ago(lastScheduledSyncAt, now)}.
          </p>
        </div>
        <ResetDemo />
      </div>

      <form action={dismissWelcomeAction} className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="ghost">
          Don&apos;t show this after sign-in
        </Button>
        <span className="text-xs text-muted-foreground">It stays under Start here in the menu.</span>
      </form>
    </div>
  );
}
