"use client";

import type { ReactNode } from "react";
import { BadgeCheck, BellRing, Heart, LogOut, Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import { DropdownMenu } from "radix-ui";
import { toast } from "sonner";
import { Link, useRouter } from "@/i18n/navigation";
import { signOut } from "@/lib/auth/client";
import type { SessionSummary } from "@/lib/contracts/auth";
import { cn } from "@/lib/utils";

// The signed-in account menu: its own chunk (account-menu.tsx loads it once a session is known), so
// the dropdown primitives and the toast library stay out of the first JavaScript of public pages.

export interface AccountDropdownProps {
  session: SessionSummary;
  name: string;
  /** The trigger's look and content, shared with the plain button shown while this chunk loads. */
  triggerClassName: string;
  children: ReactNode;
}

export default function AccountDropdown({ session, name, triggerClassName, children }: AccountDropdownProps) {
  const t = useTranslations("Auth.menu");
  const s = useTranslations("Auth.settings");
  const router = useRouter();

  async function onSignOut() {
    await signOut();
    toast.success(s("signedOut"));
    // Private layouts re-run their guard; public pages only swap the menu.
    router.refresh();
  }
  const item = cn(
    "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-sm px-3 py-2.5 text-sm outline-none",
    "data-[highlighted]:bg-surface-muted [&_svg]:size-4 [&_svg]:text-foreground-muted",
  );
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger className={triggerClassName}>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className={cn(
            "z-50 min-w-56 rounded-md border border-border bg-surface p-1 shadow-lg shadow-bab-950/10",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <div className="flex flex-col px-3 py-2">
            <span dir="auto" className="truncate text-sm font-semibold">
              {name}
            </span>
            {session.displayName && session.email ? (
              <span className="truncate text-xs text-foreground-muted" dir="ltr">
                {session.email}
              </span>
            ) : null}
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item asChild>
            <Link href="/favoris" className={item}>
              <Heart aria-hidden="true" />
              {t("favorites")}
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link href="/recherches" className={item}>
              <BellRing aria-hidden="true" />
              {t("savedSearches")}
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item asChild>
            <Link href="/parametres" className={item}>
              <Settings aria-hidden="true" />
              {t("settings")}
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link href="/verifications" className={item}>
              <BadgeCheck aria-hidden="true" />
              {t("verifications")}
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item className={item} onSelect={() => void onSignOut()}>
            <LogOut aria-hidden="true" />
            {t("signOut")}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
