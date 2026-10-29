"use client";

import type { ReactNode } from "react";
import { CarFront, House } from "lucide-react";
import { useTranslations } from "next-intl";
import { DropdownMenu } from "radix-ui";
import { Link } from "@/i18n/navigation";
import { HOLIDAY_RENTAL_SEARCH, RENT_CAR_SEARCH } from "@/lib/search/shortcuts";
import { cn } from "@/lib/utils";

// The "Louer" menu of the header: its own chunk (rent-entry.tsx loads it when the pointer reaches
// the trigger), so the dropdown primitives stay out of the first JavaScript of public pages. Open
// at once: the click that asked for it already happened. Two items, the two rental searches.

export interface RentMenuProps {
  /** The trigger's look and content, shared with the plain button shown until this chunk runs. */
  triggerClassName: string;
  children: ReactNode;
}

export default function RentMenu({ triggerClassName, children }: RentMenuProps) {
  const t = useTranslations("Nav");
  const item = cn(
    "flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-sm outline-none",
    "data-[highlighted]:bg-surface-muted [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-structure dark:[&_svg]:text-bab-200",
  );
  return (
    <DropdownMenu.Root modal={false} defaultOpen>
      <DropdownMenu.Trigger data-testid="header-rent" className={triggerClassName}>
        {children}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className={cn(
            "z-50 min-w-64 rounded-md border border-border bg-surface p-1 shadow-lg shadow-bab-950/10",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <DropdownMenu.Item asChild>
            <Link href={RENT_CAR_SEARCH} prefetch={false} className={item}>
              <CarFront aria-hidden="true" />
              <span className="flex flex-col">
                <span className="font-medium">{t("rentCar")}</span>
                <span className="text-xs text-foreground-muted">{t("rentCarHint")}</span>
              </span>
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link href={HOLIDAY_RENTAL_SEARCH} prefetch={false} className={item}>
              <House aria-hidden="true" />
              <span className="flex flex-col">
                <span className="font-medium">{t("holidayRental")}</span>
                <span className="text-xs text-foreground-muted">{t("holidayRentalHint")}</span>
              </span>
            </Link>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
