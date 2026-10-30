"use client";

import type { ReactNode } from "react";
import { CarFront, CircleHelp, House, LogIn, Mail, ScrollText, Store, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { DropdownMenu } from "radix-ui";
import { LocaleMenuItems } from "@/components/layout/locale-menu-items";
import { Link } from "@/i18n/navigation";
import { HOLIDAY_RENTAL_SEARCH, PRO_LANDING_PATH, RENT_CAR_SEARCH } from "@/lib/search/shortcuts";
import { cn } from "@/lib/utils";

// The visitor menu of the header on phones and tablets (below lg), its own chunk (visitor-entry.tsx
// loads it when the pointer reaches the trigger): sign in, create an account, then what the wide
// header shows as buttons (owner's choice B, 29 Oct 2026), the two rental searches and the Pro
// space, then the help centre, the users' contact (DSA art. 12) and, below md, the other languages
// (UX journeys counter-review, 10).
// Open at once: the click that asked for it already happened.

export type SignInHref = "/connexion" | { pathname: "/connexion"; query: { next: string } };

export interface VisitorMenuProps {
  signInHref: SignInHref;
  /** The trigger's look, name and content, shared with the plain button shown until this chunk runs. */
  triggerClassName: string;
  label: string;
  children: ReactNode;
}

export default function VisitorMenu({ signInHref, triggerClassName, label, children }: VisitorMenuProps) {
  const t = useTranslations("Nav");
  const item = cn(
    "flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-sm outline-none",
    "data-[highlighted]:bg-surface-muted [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-structure dark:[&_svg]:text-bab-200",
  );
  return (
    <DropdownMenu.Root modal={false} defaultOpen>
      <DropdownMenu.Trigger aria-label={label} data-testid="visitor-menu" className={triggerClassName}>
        {children}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className={cn(
            "z-50 min-w-64 rounded-md border border-border bg-surface p-1 shadow-lg shadow-bab-950/10",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <DropdownMenu.Item asChild>
            <Link href={signInHref} className={cn(item, "font-semibold")}>
              <LogIn aria-hidden="true" />
              {t("signIn")}
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link href="/inscription" className={item}>
              <UserPlus aria-hidden="true" />
              {t("signUp")}
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item asChild>
            <Link href={RENT_CAR_SEARCH} prefetch={false} className={item}>
              <CarFront aria-hidden="true" />
              {t("rentCar")}
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link href={HOLIDAY_RENTAL_SEARCH} prefetch={false} className={item}>
              <House aria-hidden="true" />
              {t("holidayRental")}
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link href={PRO_LANDING_PATH} prefetch={false} className={item}>
              <Store aria-hidden="true" />
              <span className="flex flex-col">
                <span>{t("proSpace")}</span>
                <span className="text-xs text-foreground-muted">{t("proHint")}</span>
              </span>
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item asChild>
            <Link href="/aide" prefetch={false} className={item}>
              <CircleHelp aria-hidden="true" />
              {t("help")}
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link href="/aide/contact" prefetch={false} className={item}>
              <Mail aria-hidden="true" />
              {t("contact")}
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link href="/demarches" prefetch={false} className={item}>
              <ScrollText aria-hidden="true" />
              {t("procedures")}
            </Link>
          </DropdownMenu.Item>
          <LocaleMenuItems itemClassName={item} className="md:hidden" />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
