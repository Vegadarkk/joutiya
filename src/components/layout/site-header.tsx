import { CirclePlus, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { AccountMenu } from "@/components/auth/account-menu";
import { Button } from "@/components/ui/button";
import { inputClassName } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Container } from "./container";
import { IntentLink } from "./intent-link";
import { LocaleSwitcher } from "./locale-switcher";
import { Logo } from "./logo";

// Every header control is a 44 px touch target (logo link included). The header search hides on
// pages whose main content has its own search form (home, /recherche): never two fields at once.

export function SiteHeader({ locale }: { locale: string }) {
  const t = useTranslations("Nav");
  return (
    <header className="threshold sticky top-0 z-40 bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
      <Container className="flex h-16 items-center gap-3 md:h-20 md:gap-5">
        {/* On every page: the home payload is prefetched when the visitor reaches for the logo, not during load. */}
        <IntentLink href="/" className="flex h-11 shrink-0 items-center rounded-sm md:h-12" aria-label={t("home")}>
          <Logo label="Joutiya" className="h-10 md:h-12" />
        </IntentLink>

        <Button asChild className="hidden md:inline-flex">
          <Link href="/deposer">
            <CirclePlus aria-hidden="true" />
            {t("post")}
          </Link>
        </Button>

        {/* Named: the home page has a second search landmark (its search panel). Hidden where the
            page shows its own search bar (home, /recherche): one search field at a time. */}
        <form
          action={`/${locale}/recherche`}
          method="get"
          role="search"
          aria-label={t("searchLabel")}
          className="relative hidden min-w-0 flex-1 md:block [:root:has(#main_[role=search])_&]:hidden"
        >
          <label htmlFor="header-search" className="sr-only">
            {t("searchLabel")}
          </label>
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-foreground-muted" aria-hidden="true" />
          <input
            id="header-search"
            name="q"
            type="search"
            enterKeyHint="search"
            maxLength={100}
            placeholder={t("searchPlaceholder")}
            className={cn(inputClassName, "bg-surface-muted ps-9")}
          />
        </form>

        <div className="ms-auto flex items-center gap-1 *:min-w-11">
          <LocaleSwitcher />
          <Button asChild variant="ghost" size="icon" className="md:hidden">
            <Link href="/deposer" aria-label={t("post")}>
              <CirclePlus className="text-primary" aria-hidden="true" />
            </Link>
          </Button>
          {/* Anonymous first on every page (public pages are static); swaps after /api/auth/me. */}
          <AccountMenu />
        </div>
      </Container>
    </header>
  );
}
