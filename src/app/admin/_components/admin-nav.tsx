"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/", label: "Quotas", adminOnly: false },
  { href: "/moderation", label: "Modération", adminOnly: false },
  { href: "/personnel", label: "Personnel", adminOnly: true },
] as const;

/** Section links of the back office; the current one carries the ochre underline. */
export function AdminNav({ admin }: { admin: boolean }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Sections du back-office" className="flex h-full items-stretch gap-1">
      {ITEMS.filter((item) => admin || !item.adminOnly).map((item) => {
        const current = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "relative flex items-center px-2 text-sm font-medium text-foreground-muted transition-colors hover:text-foreground",
              "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-t after:bg-primary after:opacity-0 after:transition-opacity",
              "aria-[current=page]:text-foreground aria-[current=page]:after:opacity-100",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
