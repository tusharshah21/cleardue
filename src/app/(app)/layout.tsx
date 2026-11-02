import Link from "next/link";
import { logoutAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { requireFreelancer } from "@/lib/auth";

const nav = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/clients", label: "Clients" },
  { href: "/invoices/new", label: "New invoice" },
];

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const freelancer = await requireFreelancer();
  return (
    <div className="flex flex-1 flex-col md:flex-row">
      <aside className="border-b bg-muted/40 p-4 md:w-56 md:border-r md:border-b-0">
        <Link href="/dashboard" className="block text-lg font-semibold">
          ClearDue
        </Link>
        <p className="mt-1 text-xs text-muted-foreground">{freelancer.businessName}</p>
        <nav className="mt-6 flex gap-1 md:flex-col">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className="rounded-md px-3 py-2 text-sm hover:bg-muted">
              {n.label}
            </Link>
          ))}
        </nav>
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
