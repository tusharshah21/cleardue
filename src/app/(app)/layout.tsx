import { requireFreelancer } from "@/lib/auth";
import { db } from "@/lib/db";
import { AppSidebar } from "./app-sidebar";

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
      <AppSidebar items={nav} businessName={freelancer.businessName} />
      <main className="flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
