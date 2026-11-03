import type { Metadata } from "next";
import Link from "next/link";
import { dismissWelcomeAction } from "@/app/actions";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { requireFreelancer } from "@/lib/auth";
import { db } from "@/lib/db";
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
  },
  {
    client: "Koala Digital",
    title: "The client's pay page",
    body: "What the client sees: answers grounded in the scope with quotes, a plan on request, and a discount request passed to Aarav. Paying closes the invoice and its tasks.",
    cta: "Open Koala's pay page",
    target: "pay",
  },
] as const;

export default async function WelcomePage() {
  const freelancer = await requireFreelancer();
  const invoices = await db.invoice.findMany({
    where: { client: { freelancerId: freelancer.id, name: { in: STORIES.map((s) => s.client) } }, planGroupId: null },
    include: { client: true },
    orderBy: { createdAt: "asc" },
  });
  const stories = STORIES.flatMap((s) => {
    const invoice = invoices.find((i) => i.client.name === s.client);
    return invoice ? [{ ...s, href: s.target === "pay" ? `/pay/${invoice.payToken}` : `/invoices/${invoice.id}` }] : [];
  });

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="space-y-2">
        <p className="text-sm font-medium text-muted-foreground">Start here</p>
        <h1 className="text-2xl font-semibold text-balance">85% of freelancers have been paid late. ClearDue finds out why each client hasn&apos;t paid and acts on it through PayPal, inside limits the freelancer sets.</h1>
        <p className="text-muted-foreground">You&apos;re signed in as {freelancer.name}, a designer in India with three overseas clients. Each story below takes a minute.</p>
      </div>

      {stories.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-3">
          {stories.map((s, n) => (
            <Card key={s.client} className="flex flex-col">
              <CardHeader>
                <CardDescription>
                  {n + 1}. {s.client}
                </CardDescription>
                <CardTitle>{s.title}</CardTitle>
              </CardHeader>
              <CardContent className="flex-1 text-sm text-muted-foreground">{s.body}</CardContent>
              <CardFooter>
                <Link href={s.href} className={buttonVariants({ variant: n === 0 ? "default" : "outline", className: "w-full" })} {...(s.target === "pay" && { target: "_blank", rel: "noopener" })}>
                  {s.cta}
                </Link>
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">The demo stories aren&apos;t in this database. Run <code>npm run seed</code> to add them.</p>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-lg border p-4">
        <p className="flex-1 text-sm text-muted-foreground">Demo resets daily. Use Reset demo if a story is already finished.</p>
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
