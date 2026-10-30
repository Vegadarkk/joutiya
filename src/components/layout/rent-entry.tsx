"use client";

import { Suspense, useId, useState } from "react";
import { CarFront, ChevronDown, House } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { HOLIDAY_RENTAL_SEARCH, RENT_CAR_SEARCH } from "@/lib/search/shortcuts";
import { cn } from "@/lib/utils";
import { lazyIsland } from "./lazy-island";
import type { RentMenuProps } from "./rent-menu";

// "Louer" in the header, beside "Vendre" (owner's choice B, 29 Oct 2026): the car and the house side
// by side (owner, same evening), then a menu with the two rental searches. Same mechanics as the
// language switcher: the menu (rent-menu.tsx, dropdown primitives) is a separate chunk, a plain
// trigger renders first, its download starts when the pointer or the focus reaches it, and the click
// opens the menu once it has arrived; if the chunk cannot be loaded, plain links stand in. Shown
// from lg; below, the rentals sit in the account menus. The word "Louer" waits for xl: at lg the
// pill holds the icons only, named for assistive technology.

const loadMenu = () => import("./rent-menu");
const RentMenu = lazyIsland(loadMenu, RentLinks);

function warmMenu(): void {
  void loadMenu().catch(() => undefined);
}

/** A floating pill of the header's right group, as tall as its neighbours (52 px from md). */
export const HEADER_PILL_CLASS = cn(
  "float-card hidden h-13 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold whitespace-nowrap text-foreground",
  "transition-[background-color,scale] duration-150 ease-door hover:bg-surface-muted active:scale-[0.98] data-[state=open]:bg-surface-muted lg:inline-flex",
);

export function RentEntry() {
  const t = useTranslations("Nav");
  const [requested, setRequested] = useState(false);
  const content = (
    <>
      <span className="flex items-center gap-0.5 text-structure dark:text-bab-200" aria-hidden="true">
        <CarFront className="size-5" />
        <House className="size-5" />
      </span>
      <span className="hidden xl:inline">{t("rent")}</span>
      <span className="sr-only xl:hidden">{t("rent")}</span>
      <ChevronDown className="size-4 text-foreground-muted" aria-hidden="true" />
    </>
  );
  const trigger = (
    <button type="button" aria-haspopup="menu" aria-expanded={false} data-testid="header-rent" className={HEADER_PILL_CLASS} onPointerEnter={warmMenu} onFocus={warmMenu} onClick={() => setRequested(true)}>
      {content}
    </button>
  );
  if (!requested) return trigger;
  return (
    <Suspense fallback={trigger}>
      <RentMenu triggerClassName={HEADER_PILL_CLASS}>{content}</RentMenu>
    </Suspense>
  );
}

/**
 * The menu without its chunk (download failed): the same trigger toggles a plain list of the two
 * links, open at first like the menu (the click asked for it). Escape closes it.
 */
export function RentLinks({ triggerClassName, children }: RentMenuProps) {
  const t = useTranslations("Nav");
  const [open, setOpen] = useState(true);
  const listId = useId();
  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button type="button" aria-expanded={open} aria-controls={listId} data-state={open ? "open" : "closed"} data-testid="header-rent" className={triggerClassName} onClick={() => setOpen(!open)}>
        {children}
      </button>
      {open ? (
        <ul id={listId} className="absolute end-0 top-full z-50 mt-1.5 min-w-56 rounded-md border border-border bg-surface p-1 shadow-lg shadow-bab-950/10">
          <li>
            <Link href={RENT_CAR_SEARCH} prefetch={false} className="flex min-h-11 items-center rounded-sm px-3 text-sm hover:bg-surface-muted">
              {t("rentCar")}
            </Link>
          </li>
          <li>
            <Link href={HOLIDAY_RENTAL_SEARCH} prefetch={false} className="flex min-h-11 items-center rounded-sm px-3 text-sm hover:bg-surface-muted">
              {t("holidayRental")}
            </Link>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
