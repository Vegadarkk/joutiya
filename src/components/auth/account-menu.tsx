"use client";

import { Suspense } from "react";
import { UserRound } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link, usePathname } from "@/i18n/navigation";
import { useSession } from "@/lib/auth/client";
import { lazyIsland } from "@/components/layout/lazy-island";
import type { SessionSummary } from "@/lib/contracts/auth";
import { cn } from "@/lib/utils";
import type { AccountDropdownProps } from "./account-dropdown";

// Header account state. Private pages render with the session the layout already knows. Public
// pages are static and carry no session: the anonymous button renders first (server and client
// alike) and swaps once GET /api/auth/me has answered. Both states are 44 px tall, so nothing shifts.
// The menu itself (account-dropdown.tsx) is a separate chunk, loaded once a session is known:
// anonymous visitors never download it, and the same trigger shows as a plain button meanwhile.
// If that chunk cannot be loaded, the trigger links to the account settings (sign-out included).

const AccountDropdown = lazyIsland(() => import("./account-dropdown"), AccountSettingsLink);

/** The account menu without its chunk (download failed): the trigger leads to the settings page. */
export function AccountSettingsLink({ triggerClassName, children }: AccountDropdownProps) {
  return (
    <Link href="/parametres" className={triggerClassName}>
      {children}
    </Link>
  );
}

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
  const locale = useLocale();
  const pathname = usePathname();
  const { status, session } = useSession();

  if (status !== "ready" || !session) {
    const next = nextFor(locale, pathname);
    return (
      <Button asChild variant="ghost" className="px-2 md:px-3">
        <Link href={next ? { pathname: "/connexion", query: { next } } : "/connexion"} className="min-w-11">
          <UserRound aria-hidden="true" />
          <span className="hidden sm:inline">{nav("signIn")}</span>
          <span className="sr-only sm:hidden">{nav("signIn")}</span>
        </Link>
      </Button>
    );
  }

  const name = session.displayName ?? session.email ?? "";
  const triggerClassName = cn(
    "inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-md px-1.5 text-sm font-medium text-foreground hover:bg-surface-muted md:px-2",
    "data-[state=open]:bg-surface-muted",
  );
  // Named by its text, not aria-label, so the name holds what is visible (WCAG 2.5.3): "Mon compte"
  // then the display name from sm; the initials are a decorative avatar.
  const triggerContent = (
    <>
      <span className="flex size-8 items-center justify-center rounded-full bg-structure text-xs font-semibold text-structure-foreground" aria-hidden="true">
        {initials(session)}
      </span>
      <span className="sr-only">{t("account")}</span>{" "}
      <span dir="auto" className="hidden max-w-32 truncate sm:inline">
        {name}
      </span>
    </>
  );
  return (
    <Suspense
      fallback={
        <button type="button" aria-haspopup="menu" aria-expanded={false} className={triggerClassName}>
          {triggerContent}
        </button>
      }
    >
      <AccountDropdown session={session} name={name} triggerClassName={triggerClassName}>
        {triggerContent}
      </AccountDropdown>
    </Suspense>
  );
}
