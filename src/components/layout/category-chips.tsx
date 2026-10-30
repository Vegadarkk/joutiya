"use client";

import { ScrollText, ShoppingBag, type LucideIcon } from "lucide-react";
import { RailScroller } from "@/components/home/rail-scroller";
import { Link, usePathname } from "@/i18n/navigation";
import { DIRECTORY_PATH } from "@/lib/search/shortcuts";
import { cn } from "@/lib/utils";
import { Container } from "./container";
import { showsCategoryRow } from "./shell-paths";

// The category row under the header (Carte vivante, lot 1): the category pages as floating chips in
// one scrolling line, then two doors in their own style, the directory of verified shops
// (« Boutiques », owner's choice of 30 Oct 2026) and the guide of the administrative procedures
// (« Démarches »). Below lg the line bleeds to the screen edge, fades out at its end (room after the
// last chip so that it scrolls clear of the fade) and the two doors close it, reached by a swipe.
// From lg the thirteen chips never fit the line (owner's report of 30 Oct 2026: the last ones were
// out of reach on a desktop, the scrollbar hidden), so the line ends with a pair of arrows, a mouse
// drag also scrolls it, and the two doors stand after it, fixed, always in view. Each link is a
// 44 px target around a 36 px chip. Labels come from the server (the Categories catalog stays out of
// the browser). Left out of the focused flows, the home page and the search page (shell-paths.ts).

export interface CategoryChip {
  id: string;
  label: string;
}

export interface CategoryChipsProps {
  items: readonly CategoryChip[];
  /** The row's name, the two doors' labels and the arrows' names. */
  label: string;
  shops: string;
  guide: string;
  previous: string;
  next: string;
}

const chip = cn(
  "flex h-9 items-center gap-1.5 rounded-full px-4 text-sm font-medium whitespace-nowrap transition-[background-color,color,box-shadow] duration-150 ease-door",
  "group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-ring",
);
const currentChip = "bg-structure text-structure-foreground shadow-[0_6px_14px_-8px_var(--float-shadow)] dark:bg-bab-600";

export function CategoryChips({ items, label, shops, guide, previous, next }: CategoryChipsProps) {
  const pathname = usePathname();
  if (!showsCategoryRow(pathname)) return null;
  const isCurrent = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  /** A door: the icon and the text in a ring, where the chips float. */
  const door = (href: string, Icon: LucideIcon, text: string) => (
    <Link href={href} prefetch={false} aria-current={isCurrent(href) ? "page" : undefined} className="group flex h-11 items-center px-0.5 outline-none">
      <span className={cn(chip, "px-3.5", isCurrent(href) ? currentChip : "text-structure ring-1 ring-border-strong ring-inset group-hover:bg-surface-muted dark:text-gold-300")}>
        <Icon className="size-4" aria-hidden="true" />
        {text}
      </span>
    </Link>
  );
  const doors = (
    <>
      <span className="h-5 w-px bg-border-strong" aria-hidden="true" />
      {door(DIRECTORY_PATH, ShoppingBag, shops)}
      {door("/demarches", ScrollText, guide)}
    </>
  );
  return (
    <nav aria-label={label} data-testid="category-chips">
      <Container className="max-w-7xl xl:max-w-[88rem]">
        <RailScroller
          arrows="trailing"
          wheel={false}
          previous={previous}
          next={next}
          arrowsClassName="hidden lg:pointer-fine:flex"
          className="lg:gap-3"
          trailing={
            <div data-testid="category-doors" className="hidden h-11 shrink-0 items-center gap-1.5 lg:flex">
              {doors}
            </div>
          }
        >
          <ul
            className={cn(
              "-mx-4 flex min-w-0 flex-1 snap-x scroll-px-4 items-center gap-1.5 overflow-x-auto ps-4 pe-16 pb-2 [scrollbar-width:none] sm:-mx-6 sm:scroll-px-6 sm:ps-6 [&::-webkit-scrollbar]:hidden",
              // The line never ends on a hard cut: a fade at its end, the last chip scrolls clear of it (UX audit, 8).
              "[mask-image:linear-gradient(to_right,#000_calc(100%-3rem),transparent)] rtl:[mask-image:linear-gradient(to_left,#000_calc(100%-3rem),transparent)]",
              "lg:mx-0 lg:scroll-px-0 lg:ps-0 lg:pe-12",
            )}
          >
            {items.map((item) => {
              const href = `/c/${item.id}`;
              return (
                <li key={item.id} className="shrink-0 snap-start">
                  <Link href={href} prefetch={false} aria-current={isCurrent(href) ? "page" : undefined} className="group flex h-11 items-center px-0.5 outline-none">
                    <span className={cn(chip, isCurrent(href) ? currentChip : "float-card text-foreground group-hover:bg-surface-muted")}>{item.label}</span>
                  </Link>
                </li>
              );
            })}
            <li data-testid="category-doors" className="flex shrink-0 snap-start items-center gap-1.5 lg:hidden">
              {doors}
            </li>
          </ul>
        </RailScroller>
      </Container>
    </nav>
  );
}
