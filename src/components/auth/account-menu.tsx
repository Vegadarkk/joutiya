"use client";

import { Suspense } from "react";
import { Heart, UserRound } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { useSession } from "@/lib/auth/client";
import { lazyIsland } from "@/components/layout/lazy-island";
import { canMessage } from "@/components/messages/can-message";
import { MessagesLinkPlain } from "@/components/messages/messages-link-plain";
import type { SessionSummary } from "@/lib/contracts/auth";
import { cn } from "@/lib/utils";
import type { AccountDropdownProps } from "./account-dropdown";

// Header account state, inside the header's pill of round 44 px buttons: messages (members),
// favourites (from md), then the avatar or the sign-in link. Private pages render with the session
// the layout already knows. Public pages are static and carry no session: the anonymous state
// renders first (server and client alike) and swaps once GET /api/auth/me has answered. Both
// states are 44 px tall, so nothing shifts.
// The menu itself (account-dropdown.tsx) is a separate chunk, loaded once a session is known:
// anonymous visitors never download it, and the same trigger shows as a plain button meanwhile.
// If that chunk cannot be loaded, the trigger links to the account settings (sign-out included).

const AccountDropdown = lazyIsland(() => import("./account-dropdown"), AccountSettingsLink);
// Messages link with the unread badge (phase 5): it opens the live stream, so members only and
// in its own chunk; the plain link stands in while it loads or if it cannot be downloaded.
const MessagesLink = lazyIsland(() => import("@/components/messages/messages-link"), MessagesLinkPlain);

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

/** A round 44 px button of the header pill. */
const PILL_BUTTON_CLASS =
  "inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-full text-sm font-medium text-foreground transition-[background-color,scale] duration-150 ease-door hover:bg-surface-muted active:scale-[0.97] [&_svg]:size-[1.15rem]";

function FavoritesLink() {
  const t = useTranslations("Auth.menu");
  return (
    <Link href="/favoris" aria-label={t("favorites")} className={cn(PILL_BUTTON_CLASS, "hidden md:inline-flex")}>
      <Heart aria-hidden="true" />
    </Link>
  );
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
      <>
        <FavoritesLink />
        <Link href={next ? { pathname: "/connexion", query: { next } } : "/connexion"} className={cn(PILL_BUTTON_CLASS, "lg:px-3.5")}>
          <UserRound aria-hidden="true" />
          <span className="hidden lg:inline">{nav("signIn")}</span>
          <span className="sr-only lg:hidden">{nav("signIn")}</span>
        </Link>
      </>
    );
  }

  const name = session.displayName ?? session.email ?? "";
  const triggerClassName = cn(PILL_BUTTON_CLASS, "data-[state=open]:bg-surface-muted");
  // Named by its text, not aria-label (WCAG 2.5.3): "Mon compte"; the initials are a decorative
  // avatar, and the menu opens on the display name.
  const triggerContent = (
    <>
      <span className="flex size-9 items-center justify-center rounded-full bg-structure text-xs font-semibold text-structure-foreground dark:bg-bab-600" aria-hidden="true">
        {initials(session)}
      </span>
      <span className="sr-only">{t("account")}</span>
    </>
  );
  return (
    <>
      {canMessage(session) ? (
        <Suspense fallback={<MessagesLinkPlain />}>
          <MessagesLink />
        </Suspense>
      ) : null}
      <FavoritesLink />
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
    </>
  );
}
