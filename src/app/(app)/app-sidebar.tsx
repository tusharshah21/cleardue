"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { CircleHelp, Compass, FilePlus2, LayoutDashboard, ListChecks, LogOut, Send, Sparkles, Users } from "lucide-react";
import { logoutAction } from "@/app/actions";
import { Sidebar, SidebarBody, SidebarLink, useSidebar } from "@/components/ui/sidebar";
import { startTour } from "@/components/tour/tour-runner";

interface Item {
  href: string;
  label: string;
  count?: number;
}

const ICONS: Record<string, typeof Compass> = {
  "/welcome": Compass,
  "/dashboard": LayoutDashboard,
  "/approvals": ListChecks,
  "/outbox": Send,
  "/analyst": Sparkles,
  "/clients": Users,
  "/invoices/new": FilePlus2,
};
const iconClass = "size-5 flex-shrink-0 text-sidebar-foreground";

function Brand({ businessName }: { businessName: string }) {
  const { open } = useSidebar();
  return (
    <div>
      <Link href="/dashboard" aria-label="ClearDue" className="relative z-20 flex items-center gap-2 py-1 text-lg font-semibold">
        <Image src="/brand/cleardue-mark.png" alt="" width={28} height={28} className="size-7 flex-shrink-0" priority />
        {open && (
          <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="whitespace-pre">
            ClearDue
          </motion.span>
        )}
      </Link>
      {open && businessName && (
        <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-1 truncate text-xs text-muted-foreground">
          {businessName}
        </motion.p>
      )}
    </div>
  );
}

function TourItem({ close }: { close: () => void }) {
  const { open } = useSidebar();
  return (
    <button
      type="button"
      aria-label="Take the tour"
      onClick={() => {
        close();
        startTour();
      }}
      className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-sidebar-accent"
    >
      <CircleHelp className={iconClass} />
      {open && (
        <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="whitespace-pre">
          Tour
        </motion.span>
      )}
    </button>
  );
}

function SignOut() {
  const { open } = useSidebar();
  return (
    <form action={logoutAction}>
      <button type="submit" aria-label="Sign out" className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-sidebar-accent">
        <LogOut className={iconClass} />
        {open && (
          <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="whitespace-pre">
            Sign out
          </motion.span>
        )}
      </button>
    </form>
  );
}

/** The app's navigation: a rail on desktop that opens over the page on hover or focus (the page itself never shifts), a menu on a phone. */
export function AppSidebar({ items, businessName }: { items: Item[]; businessName: string }) {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  return (
    <div className="relative flex-shrink-0 md:w-[60px]">
      <div className="md:fixed md:inset-y-0 md:left-0 md:z-30">
        <Sidebar open={open} setOpen={setOpen}>
          <SidebarBody className="justify-between gap-6 border-r" bar={<Brand businessName="" />}>
            <div className="flex flex-1 flex-col overflow-x-hidden overflow-y-auto">
              <Brand businessName={businessName} />
              <nav className="mt-8 flex flex-col gap-1">
                {items.map((n) => {
                  const Icon = ICONS[n.href] ?? Compass;
                  const active = path === n.href || (n.href !== "/dashboard" && path.startsWith(`${n.href}/`));
                  return (
                    <SidebarLink
                      key={n.href}
                      active={active}
                      label={n.count ? `${n.label}, ${n.count} waiting` : n.label}
                      onClick={() => setOpen(false)}
                      link={{
                        label: n.label,
                        href: n.href,
                        icon: (
                          <span className="relative flex-shrink-0">
                            <Icon className={iconClass} />
                            {!!n.count && <span className="absolute -top-1.5 -right-2 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground">{n.count}</span>}
                          </span>
                        ),
                      }}
                    />
                  );
                })}
                <TourItem close={() => setOpen(false)} />
              </nav>
            </div>
            <SignOut />
          </SidebarBody>
        </Sidebar>
      </div>
    </div>
  );
}
