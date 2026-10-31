import { useLocale, useTranslations } from "next-intl";
import { ConsentLink } from "@/components/consent/consent-link";
import { Link } from "@/i18n/navigation";
import { LEGAL_PAGES } from "@/config/legal-pages";
import { Container } from "@/components/layout/container";
import { LocaleSwitcher } from "@/components/layout/locale-switcher";
import { Logo } from "@/components/layout/logo";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { CATEGORIES } from "@/config/categories";
import {
  REGIONS,
  cityName,
  citiesOfRegion,
  regionName,
} from "@/config/regions";
import { searchPath } from "@/lib/search/params";
import {
  DIRECTORY_PATH,
  PRICING_PATH,
  PRO_LANDING_PATH,
  PRO_SPACE_PATH,
} from "@/lib/search/shortcuts";
import { SITE_NAME, type Locale } from "@/config/site";
import { quietLinkClassName } from "@/components/ui/text-link";
import { cn } from "@/lib/utils";

const linkClass = cn(
  "text-foreground-muted hover:text-foreground",
  quietLinkClassName,
);
// The directory band sits on the structure green: lighter links, underlined like a plan of the site.
const directoryLinkClass =
  "text-structure-foreground/80 underline decoration-structure-foreground/30 underline-offset-2 hover:text-structure-foreground hover:decoration-current";

/** Cities listed under each region of the directory: its largest ones. */
const CITIES_PER_REGION = 4;

/**
 * Footer in Leboncoin's layout (owner, 2026-10-31): a short presentation, the plan of every category
 * and subcategory, the regions with their main cities, then four columns (about, legal information,
 * Pro solutions, questions). Directory links go to the search (a subcategory landing page answers
 * 404 while empty) and never prefetch: there are about a hundred of them on every page.
 */
export function Footer({ publisher }: { publisher: string }) {
  const t = useTranslations("Footer");
  const names = useTranslations("Categories");
  type CategoryKey = Parameters<typeof names>[0];
  const locale = useLocale() as Locale;
  const year = new Date().getFullYear();
  const column = (name: "legal" | "trust") =>
    LEGAL_PAGES.filter((page) => page.column === name);
  const columnTitle = "mb-4 font-semibold";
  const directoryTitle = "mb-2 text-sm font-semibold tracking-wide uppercase";
  // Thin green line on top: the logo's door outline (bab-700); bab-600 in dark, where structure equals this background.
  return (
    // Steps aside under an application screen on phones and tablets (the messaging shell, data-shell="app").
    <footer className="mt-auto border-t-2 border-structure bg-surface-brand text-foreground search-map:hidden max-lg:[:root:has([data-shell=app])_&]:hidden dark:border-bab-600">
      <div className="bg-structure text-structure-foreground">
        <Container className="flex flex-col gap-10 py-10">
          <p className="max-w-4xl text-sm text-pretty text-structure-foreground/85">
            {t("intro", { site: SITE_NAME })}
          </p>
          <nav
            aria-label={t("categoriesLabel")}
            className="columns-2 gap-8 sm:columns-3 lg:columns-4"
          >
            {CATEGORIES.map((category) => (
              <div key={category.id} className="mb-7 break-inside-avoid">
                <h3 className={directoryTitle}>
                  <Link
                    href={`/c/${category.id}`}
                    prefetch={false}
                    className={directoryLinkClass}
                  >
                    {names(`${category.id}.name` as CategoryKey)}
                  </Link>
                </h3>
                <ul className="flex flex-col gap-1.5 text-sm">
                  {category.subcategories.map((sub) => (
                    <li key={sub.id}>
                      <Link
                        href={searchPath({
                          category: category.id,
                          subcategory: sub.id,
                        })}
                        prefetch={false}
                        className={directoryLinkClass}
                      >
                        {names(`${category.id}.sub.${sub.id}` as CategoryKey)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
          <nav
            aria-label={t("regionsLabel")}
            className="columns-2 gap-8 border-t border-structure-foreground/15 pt-8 sm:columns-3 lg:columns-4"
          >
            {REGIONS.map((region) => (
              <div key={region.code} className="mb-7 break-inside-avoid">
                <h3 className={directoryTitle}>
                  <Link
                    href={searchPath({ region: region.code })}
                    prefetch={false}
                    className={directoryLinkClass}
                  >
                    {regionName(region, locale)}
                  </Link>
                </h3>
                <ul className="flex flex-col gap-1.5 text-sm">
                  {[...citiesOfRegion(region.code)]
                    .sort((a, b) => b.population - a.population)
                    .slice(0, CITIES_PER_REGION)
                    .map((city) => (
                      <li key={city.slug}>
                        <Link
                          href={searchPath({ city: city.slug })}
                          prefetch={false}
                          className={directoryLinkClass}
                        >
                          {cityName(city, locale)}
                        </Link>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </nav>
        </Container>
      </div>
      <Container className="grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-4">
          <Logo label={SITE_NAME} className="h-12 w-fit" />
          <p className="max-w-xs text-sm text-pretty text-foreground-muted">
            {t("about")}
          </p>
          <ul
            className="flex flex-col gap-2.5 text-sm"
            aria-label={t("trustTitle")}
          >
            {column("trust").map((page) => (
              <li key={page.slug}>
                <Link href={`/legal/${page.slug}`} className={linkClass}>
                  {t(`links.${page.key}`)}
                </Link>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <ThemeToggle className="w-fit bg-background/40" />
            {/* Phones only: from md the language menu is in the header. */}
            <LocaleSwitcher className="border border-border bg-background/40 md:hidden" />
          </div>
        </div>
        <nav aria-labelledby="footer-legal">
          <h2 id="footer-legal" className={columnTitle}>
            {t("legalTitle")}
          </h2>
          <ul className="flex flex-col gap-2.5 text-sm">
            {column("legal").map((page) => (
              <li key={page.slug}>
                <Link href={`/legal/${page.slug}`} className={linkClass}>
                  {t(`links.${page.key}`)}
                </Link>
              </li>
            ))}
            <li>
              <ConsentLink className="text-foreground-muted hover:text-foreground" />
            </li>
          </ul>
        </nav>
        <nav aria-labelledby="footer-pros">
          <h2 id="footer-pros" className={columnTitle}>
            {t("prosTitle")}
          </h2>
          <ul className="flex flex-col gap-2.5 text-sm">
            <li>
              <Link
                href={PRO_LANDING_PATH}
                prefetch={false}
                className={linkClass}
              >
                {t("becomePro")}
              </Link>
            </li>
            <li>
              <Link href={PRICING_PATH} prefetch={false} className={linkClass}>
                {t("pricing")}
              </Link>
            </li>
            <li>
              {/* The directory is rendered from live data (ISR): no prefetch from every page, like its other doors. */}
              <Link
                href={DIRECTORY_PATH}
                prefetch={false}
                className={linkClass}
              >
                {t("shops")}
              </Link>
            </li>
            <li>
              <Link
                href={PRO_SPACE_PATH}
                prefetch={false}
                className={linkClass}
              >
                {t("createShop")}
              </Link>
            </li>
            <li>
              <Link href="/demarches" className={linkClass}>
                {t("guide")}
              </Link>
            </li>
          </ul>
        </nav>
        <nav aria-labelledby="footer-questions">
          <h2 id="footer-questions" className={columnTitle}>
            {t("questionsTitle")}
          </h2>
          <ul className="flex flex-col gap-2.5 text-sm">
            {/* The users' point of contact (DSA art. 12), first: a visitor reads it before the authorities' one. */}
            <li>
              <Link href="/aide/contact" className={linkClass}>
                {t("contact")}
              </Link>
            </li>
            <li>
              <Link href="/aide" className={linkClass}>
                {t("help")}
              </Link>
            </li>
            <li>
              <Link href="/deposer" prefetch={false} className={linkClass}>
                {t("post")}
              </Link>
            </li>
            <li>
              <Link
                href="/porte-monnaie"
                prefetch={false}
                className={linkClass}
              >
                {t("wallet")}
              </Link>
            </li>
          </ul>
        </nav>
      </Container>
      <div className="border-t border-foreground/10">
        {/* Phones: room at the end for the floating "Vendre" arch. */}
        <Container className="flex flex-col gap-2 py-5 pb-24 text-xs text-foreground-muted sm:flex-row sm:items-center sm:justify-between md:pb-5">
          <p className="max-w-2xl text-pretty">{t("disclaimer")}</p>
          <p className="shrink-0">{t("copyright", { year, publisher })}</p>
        </Container>
      </div>
    </footer>
  );
}
