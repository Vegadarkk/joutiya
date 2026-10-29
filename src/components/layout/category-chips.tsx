"use client";

import { ScrollText } from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { Container } from "./container";
import { showsCategoryRow } from "./shell-paths";

// The category row under the header (Carte vivante, lot 1): the eleven category pages as floating
// chips, then the admin procedures guide. One scrolling line at every width, bleeding to the screen
// edge below lg and fading out at the container's end from lg (room after the last chip so that it
// scrolls clear of the fade). Each link is a 44 px target around a 36 px chip. Labels come from the server
// (the Categories catalog stays out of the browser). Left out of the focused flows.

export interface CategoryChip {
  id: string;
  label: string;
}

const chip = cn(
  "flex h-9 items-center gap-1.5 rounded-full px-4 text-sm font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-150 ease-door",
  "group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-ring",
);

export function CategoryChips({ items, label, guide }: { items: readonly CategoryChip[]; label: string; guide: string }) {
  const pathname = usePathname();
  if (!showsCategoryRow(pathname)) return null;
  return (
    <nav aria-label={label} data-testid="category-chips">
      <Container>
        <ul
          className={cn(
            "-mx-4 flex snap-x scroll-px-4 items-center gap-1.5 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:-mx-6 sm:scroll-px-6 sm:px-6 [&::-webkit-scrollbar]:hidden",
            "lg:mx-0 lg:scroll-px-0 lg:ps-0 lg:pe-16 lg:[mask-image:linear-gradient(to_right,#000_calc(100%-4rem),transparent)] lg:rtl:[mask-image:linear-gradient(to_left,#000_calc(100%-4rem),transparent)]",
          )}
        >
          {items.map((item) => {
            const href = `/c/${item.id}`;
            const current = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <li key={item.id} className="shrink-0 snap-start">
                <Link href={href} prefetch={false} aria-current={current ? "page" : undefined} className="group flex h-11 items-center px-0.5 outline-none">
                  <span
                    className={cn(
                      chip,
                      current
                        ? "bg-structure text-structure-foreground shadow-[0_6px_14px_-8px_var(--float-shadow)] dark:bg-bab-600"
                        : "float-card text-foreground group-hover:bg-surface-muted",
                    )}
                  >
                    {item.label}
                  </span>
                </Link>
              </li>
            );
          })}
          <li className="flex shrink-0 snap-start items-center gap-1.5">
            <span className="h-5 w-px bg-border-strong" aria-hidden="true" />
            <Link href="/demarches" className="group flex h-11 items-center px-0.5 outline-none">
              <span className={cn(chip, "px-3.5 text-structure ring-1 ring-border-strong ring-inset group-hover:bg-surface-muted dark:text-gold-300")}>
                <ScrollText className="size-4" aria-hidden="true" />
                {guide}
              </span>
            </Link>
          </li>
        </ul>
      </Container>
    </nav>
  );
}
