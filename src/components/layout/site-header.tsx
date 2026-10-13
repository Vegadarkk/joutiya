import { CirclePlus, Search, UserRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { inputClassName } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Container } from "./container";
import { LocaleSwitcher } from "./locale-switcher";
import { Logo } from "./logo";

export function SiteHeader({ locale }: { locale: string }) {
  const t = useTranslations("Nav");
  return (
    <header className="threshold sticky top-0 z-40 bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
      <Container className="flex h-16 items-center gap-3 md:h-20 md:gap-5">
        <Link href="/" className="h-10 shrink-0 rounded-sm md:h-12" aria-label={t("home")}>
          <Logo label="Joutiya" className="h-full" />
        </Link>

        <Button asChild className="hidden md:inline-flex">
          <Link href="/deposer">
            <CirclePlus aria-hidden="true" />
            {t("post")}
          </Link>
        </Button>

        <form action={`/${locale}/recherche`} method="get" role="search" className="relative hidden min-w-0 flex-1 md:block">
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

        <div className="ms-auto flex items-center gap-1 md:ms-0">
          <LocaleSwitcher />
          <Button asChild variant="ghost" size="icon" className="md:hidden">
            <Link href="/deposer" aria-label={t("post")}>
              <CirclePlus className="text-primary" aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild variant="ghost" className="px-2 md:px-3">
            <Link href="/connexion">
              <UserRound aria-hidden="true" />
              <span className="hidden sm:inline">{t("signIn")}</span>
              <span className="sr-only sm:hidden">{t("signIn")}</span>
            </Link>
          </Button>
        </div>
      </Container>
    </header>
  );
}
