"use client";

import { Suspense, useId, useState } from "react";
import { UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { lazyIsland } from "@/components/layout/lazy-island";
import { HOLIDAY_RENTAL_SEARCH, PRO_LANDING_PATH, RENT_CAR_SEARCH } from "@/lib/search/shortcuts";
import { cn } from "@/lib/utils";
import type { SignInHref, VisitorMenuProps } from "./visitor-menu";

// The anonymous account button below lg (owner's choice B, 29 Oct 2026): a menu rather than the
// sign-in link alone, so a phone reaches the rentals and the Pro space from the header. Same
// mechanics as the language switcher: the menu (visitor-menu.tsx) is a separate chunk, the plain
// trigger renders first, its download starts when the pointer or the focus reaches it, and the click
// opens the menu once it has arrived; if the chunk cannot be loaded, plain links stand in.

const loadMenu = () => import("./visitor-menu");
const VisitorMenu = lazyIsland(loadMenu, VisitorLinks);

function warmMenu(): void {
  void loadMenu().catch(() => undefined);
}

export function VisitorEntry({ signInHref, className }: { signInHref: SignInHref; className?: string }) {
  const t = useTranslations("Nav");
  const [requested, setRequested] = useState(false);
  const triggerClassName = cn(className, "data-[state=open]:bg-surface-muted");
  const content = <UserRound aria-hidden="true" />;
  const trigger = (
    <button type="button" aria-haspopup="menu" aria-expanded={false} aria-label={t("visitorMenu")} data-testid="visitor-menu" className={triggerClassName} onPointerEnter={warmMenu} onFocus={warmMenu} onClick={() => setRequested(true)}>
      {content}
    </button>
  );
  if (!requested) return trigger;
  return (
    <Suspense fallback={trigger}>
      <VisitorMenu signInHref={signInHref} triggerClassName={triggerClassName} label={t("visitorMenu")}>
        {content}
      </VisitorMenu>
    </Suspense>
  );
}

/** The menu without its chunk (download failed): the same trigger toggles a plain list, open at first. */
export function VisitorLinks({ signInHref, triggerClassName, label, children }: VisitorMenuProps) {
  const t = useTranslations("Nav");
  const [open, setOpen] = useState(true);
  const listId = useId();
  const link = "flex min-h-11 items-center rounded-sm px-3 text-sm hover:bg-surface-muted";
  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <button type="button" aria-expanded={open} aria-controls={listId} aria-label={label} data-state={open ? "open" : "closed"} data-testid="visitor-menu" className={triggerClassName} onClick={() => setOpen(!open)}>
        {children}
      </button>
      {open ? (
        <ul id={listId} className="absolute end-0 top-full z-50 mt-1.5 min-w-56 rounded-md border border-border bg-surface p-1 shadow-lg shadow-bab-950/10">
          <li>
            <Link href={signInHref} className={cn(link, "font-semibold")}>
              {t("signIn")}
            </Link>
          </li>
          <li>
            <Link href="/inscription" className={link}>
              {t("signUp")}
            </Link>
          </li>
          <li>
            <Link href={RENT_CAR_SEARCH} prefetch={false} className={link}>
              {t("rentCar")}
            </Link>
          </li>
          <li>
            <Link href={HOLIDAY_RENTAL_SEARCH} prefetch={false} className={link}>
              {t("holidayRental")}
            </Link>
          </li>
          <li>
            <Link href={PRO_LANDING_PATH} prefetch={false} className={link}>
              {t("proSpace")}
            </Link>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
