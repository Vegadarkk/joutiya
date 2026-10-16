"use client";

import { BadgeCheck, LogOut, Settings, UserRound } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { DropdownMenu } from "radix-ui";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { signOut, useSession } from "@/lib/auth/client";
import type { SessionSummary } from "@/lib/contracts/auth";
import { cn } from "@/lib/utils";

// Header account state. Private pages render with the session the layout already knows. Public
// pages are static and carry no session: the anonymous button renders first (server and client
// alike) and swaps once GET /api/auth/me has answered. Both states are 44 px tall, so nothing shifts.

/** Pages of the sign-in flow itself: coming back to them after signing in makes no sense. */
const AUTH_PATHS = ["/connexion", "/inscription", "/mot-de-passe-oublie", "/action"];

/** The `?next=` of the header's sign-in link: this page (locale prefix included, as the account guard sends it). */
function nextFor(locale: string, pathname: string): string | undefined {
  if (AUTH_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) return undefined;
  return `/${locale}${pathname === "/" ? "" : pathname}`;
}

export function initials(session: SessionSummary): string {
  const words = (session.displayName ?? "").trim().split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : (words[0]?.slice(0, 1) ?? session.email?.slice(0, 1) ?? "?");
  return letters.toLocaleUpperCase();
}

export function AccountMenu() {
  const nav = useTranslations("Nav");
  const t = useTranslations("Auth.menu");
  const s = useTranslations("Auth.settings");
  const router = useRouter();
  const locale = useLocale();
  const pathname = usePathname();
  const { status, session } = useSession();

  if (status !== "ready" || !session) {
    const next = nextFor(locale, pathname);
    return (
      <Button asChild variant="ghost" className="px-2 md:px-3">
        <Link href={next ? { pathname: "/connexion", query: { next } } : "/connexion"}>
          <UserRound aria-hidden="true" />
          <span className="hidden sm:inline">{nav("signIn")}</span>
          <span className="sr-only sm:hidden">{nav("signIn")}</span>
        </Link>
      </Button>
    );
  }

  const name = session.displayName ?? session.email ?? "";
  async function onSignOut() {
    await signOut();
    toast.success(s("signedOut"));
    // Private layouts re-run their guard; public pages only swap the menu.
    router.refresh();
  }
  const item = cn(
    "flex cursor-pointer items-center gap-2.5 rounded-sm px-3 py-2.5 text-sm outline-none",
    "data-[highlighted]:bg-surface-muted [&_svg]:size-4 [&_svg]:text-foreground-muted",
  );
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        className={cn(
          "inline-flex h-11 items-center gap-2 rounded-md px-1.5 text-sm font-medium text-foreground hover:bg-surface-muted md:px-2",
          "data-[state=open]:bg-surface-muted",
        )}
        aria-label={t("account")}
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-structure text-xs font-semibold text-structure-foreground" aria-hidden="true">
          {initials(session)}
        </span>
        <span className="hidden max-w-32 truncate sm:inline">{name}</span>
      </DropdownMenu.Trigger>
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
            <span className="truncate text-sm font-semibold">{name}</span>
            {session.displayName && session.email ? (
              <span className="truncate text-xs text-foreground-muted" dir="ltr">
                {session.email}
              </span>
            ) : null}
          </div>
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
