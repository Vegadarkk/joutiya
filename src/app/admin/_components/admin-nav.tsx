"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/", label: "Quotas", adminOnly: false },
  { href: "/signalements", label: "Signalements", adminOnly: false },
  { href: "/recours", label: "Recours", adminOnly: false },
  { href: "/moderation", label: "Annonces retenues", adminOnly: false },
  { href: "/comptes", label: "Comptes", adminOnly: false },
  { href: "/pros", label: "Comptes Pro", adminOnly: false },
  { href: "/statistiques", label: "Statistiques", adminOnly: false },
  { href: "/ventes", label: "Ventes", adminOnly: true },
  { href: "/autorites", label: "Autorités", adminOnly: true },
  { href: "/personnel", label: "Personnel", adminOnly: true },
  { href: "/parametres/legal", label: "Mentions légales", adminOnly: true },
  { href: "/parametres/paiements", label: "Paiement vendeur", adminOnly: true },
] as const;

/** Pages reached from a section without being listed (a decision opens from the reports and the appeals). */
const PARENT: Record<string, string> = { "/decisions": "/signalements", "/conversations": "/signalements" };

/** Section links of the back office; the current one carries the ochre underline. */
export function AdminNav({ admin, className }: { admin: boolean; className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Sections du back-office" className={cn("flex items-stretch gap-1 overflow-x-auto [scrollbar-width:none] xl:h-14", className)}>
      {ITEMS.filter((item) => admin || !item.adminOnly).map((item) => {
        const section = Object.entries(PARENT).find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? pathname;
        const current = item.href === "/" ? pathname === "/" : section.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "relative flex min-h-11 shrink-0 items-center px-2 text-sm font-medium text-foreground-muted transition-colors hover:text-foreground",
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
