import Image from "next/image";
import Link from "next/link";
import { logoutAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { requireFreelancer } from "@/lib/auth";
import { db } from "@/lib/db";
import { NavLinks } from "./nav-links";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const freelancer = await requireFreelancer();
  const [proposals, tasks] = await Promise.all([
    db.proposedAction.count({ where: { status: "pending", case: { invoice: { client: { freelancerId: freelancer.id } } } } }),
    db.task.count({ where: { done: false, invoice: { client: { freelancerId: freelancer.id } } } }),
  ]);
  const pending = proposals + tasks;
  const nav = [
    { href: "/welcome", label: "Start here" },
    { href: "/dashboard", label: "Dashboard" },
    { href: "/approvals", label: "Approvals", count: pending },
    { href: "/outbox", label: "Outbox" },
    { href: "/analyst", label: "Analyst" },
    { href: "/clients", label: "Clients" },
    { href: "/invoices/new", label: "New invoice" },
  ];
  return (
    <div className="flex flex-1 flex-col md:flex-row">
      <aside className="border-b bg-muted/40 p-4 md:w-56 md:border-r md:border-b-0">
        <Link href="/dashboard" className="flex items-center gap-2 text-lg font-semibold">
          <Image src="/brand/cleardue-mark.png" alt="" width={28} height={28} className="size-7" priority />
          ClearDue
        </Link>
        <p className="mt-1 text-xs text-muted-foreground">{freelancer.businessName}</p>
        <NavLinks items={nav} />
        <form action={logoutAction} className="mt-6">
          <Button variant="ghost" size="sm" type="submit">
            Sign out
          </Button>
        </form>
      </aside>
      <main className="flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
