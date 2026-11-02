"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLinks({ items }: { items: { href: string; label: string; count?: number }[] }) {
  const path = usePathname();
  return (
    <nav className="mt-6 flex flex-wrap gap-1 md:flex-col">
      {items.map((n) => {
        const active = path === n.href || (n.href !== "/dashboard" && path.startsWith(`${n.href}/`));
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-medium"
          >
            {n.label}
            {!!n.count && (
              <span className="rounded-full bg-primary px-2 text-xs text-primary-foreground" aria-label={`${n.count} waiting`}>
                {n.count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
