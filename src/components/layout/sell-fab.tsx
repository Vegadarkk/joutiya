"use client";

import { Plus } from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { showsSellButton } from "./shell-paths";

// "Vendre" on a phone (Carte vivante, lot 1): the ochre arch floating at the bottom end, above the
// home indicator. Left out where it would sit on a form or a bottom bar (shell-paths.ts), and
// hidden while the cookie banner is up: it never covers that choice. It also steps aside while a
// field of the page has the focus (the rental module's dates, a filter): UX audit, finding 13. The
// footer keeps a lane for it at the end of the page; `data-sell-fab` is the tests' hook.

export function SellFab({ label }: { label: string }) {
  const pathname = usePathname();
  if (!showsSellButton(pathname)) return null;
  return (
    <Link
      href="/deposer"
      aria-label={label}
      data-sell-fab=""
      className={cn(
        "sell-arch fixed end-4 bottom-[max(1rem,calc(env(safe-area-inset-bottom)+0.5rem))] z-30 flex h-15 w-13 items-end justify-center pb-3.5 md:hidden",
        "transition-[background-color,scale] duration-150 ease-door hover:bg-ochre-700 active:scale-95",
        "[:root:has([data-testid=consent-banner])_&]:hidden [:root:has(main_:is(input,select,textarea):focus)_&]:hidden",
        // The search map's sheet (lot 2): the arch stands above it, and leaves when it fills the screen.
        "search-map:bottom-[calc(var(--search-sheet,0px)+0.75rem)] search-map:transition-[bottom] [:root[data-search-snap=full]_&]:search-map:hidden",
      )}
    >
      <Plus className="size-6" strokeWidth={2.25} aria-hidden="true" />
    </Link>
  );
}
