import { MapPin, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { inputClassName } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Home hero: the bab of the logo as a wide pointed arch over the search, standing on the gold
 * threshold. The one bold element of the page; everything around it stays quiet.
 */
export function SearchPanel({ locale }: { locale: string }) {
  const t = useTranslations("Home");
  return (
    <div className="relative">
      <svg className="block h-10 w-full text-structure sm:h-16" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 20C0 9 24 3 50 0c26 3 50 9 50 20z" fill="currentColor" />
      </svg>
      <div className="bg-structure px-5 pb-8 pt-2 text-structure-foreground sm:px-10 sm:pb-12">
        <h1 className="mx-auto max-w-2xl text-center text-2xl font-semibold text-balance sm:text-4xl">{t("title")}</h1>
        <p className="mx-auto mt-3 max-w-xl text-center text-structure-foreground/80 text-pretty sm:text-lg">{t("subtitle")}</p>
        <form
          action={`/${locale}/recherche`}
          method="get"
          role="search"
          className="mx-auto mt-7 grid max-w-3xl gap-2 rounded-lg bg-surface p-2 text-foreground shadow-xl shadow-bab-950/20 sm:grid-cols-[1.6fr_1fr_auto]"
        >
          <div className="relative">
            <label htmlFor="home-q" className="sr-only">
              {t("searchLabel")}
            </label>
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-foreground-muted" aria-hidden="true" />
            <input
              id="home-q"
              name="q"
              type="search"
              enterKeyHint="search"
              maxLength={100}
              placeholder={t("searchPlaceholder")}
              className={cn(inputClassName, "h-12 border-transparent bg-surface-muted ps-9")}
            />
          </div>
          <div className="relative">
            <label htmlFor="home-city" className="sr-only">
              {t("cityLabel")}
            </label>
            <MapPin className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-foreground-muted" aria-hidden="true" />
            <input
              id="home-city"
              name="ville"
              type="text"
              autoComplete="address-level2"
              maxLength={60}
              placeholder={t("cityPlaceholder")}
              className={cn(inputClassName, "h-12 border-transparent bg-surface-muted ps-9")}
            />
          </div>
          <Button type="submit" size="lg" className="h-12">
            <Search aria-hidden="true" />
            {t("submit")}
          </Button>
        </form>
      </div>
      <div className="h-2 rounded-b-sm bg-featured" aria-hidden="true" />
    </div>
  );
}
