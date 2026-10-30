import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { ConsentLink } from "@/components/consent/consent-link";
import { LocaleSwitcher } from "@/components/layout/locale-switcher";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { quietLinkClassName } from "@/components/ui/text-link";
import { LEGAL_PAGES } from "@/config/legal-pages";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

// Foot of the map panel (Carte vivante, lot 2): the map view has no page footer, so the legal
// links, the neutral-host notice, the theme and (phones) the languages live here. The four most
// asked links and the users' contact (DSA art. 12) stay in sight; every other one sits in a
// disclosure that works without script.

const SHORT = ["cgu", "confidentialite", "cookies", "mentions-legales"] as const;
const link = cn("text-foreground-muted hover:text-foreground", quietLinkClassName);

export function PanelLegal({ publisher, className }: { publisher: string; className?: string }) {
  const t = useTranslations("Footer");
  const own = useTranslations("SearchMap.legal");
  const year = new Date().getFullYear();
  return (
    <footer data-testid="panel-legal" className={cn("flex flex-col gap-2 border-t border-border px-4 pt-3 pb-4 text-xs", className)}>
      <nav aria-label={t("legalTitle")}>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {SHORT.map((slug) => {
            const page = LEGAL_PAGES.find((entry) => entry.slug === slug);
            if (!page) return null;
            return (
              <li key={slug}>
                <Link href={`/legal/${slug}`} className={cn(link, "inline-flex min-h-6 items-center pointer-coarse:min-h-11")}>
                  {own(`short.${page.key as "cgu" | "confidentialite" | "cookies" | "mentions"}`)}
                </Link>
              </li>
            );
          })}
          <li>
            <Link href="/aide/contact" className={cn(link, "inline-flex min-h-6 items-center pointer-coarse:min-h-11")}>
              {t("contact")}
            </Link>
          </li>
        </ul>
      </nav>
      <details className="group/legal">
        <summary className="flex min-h-8 pointer-coarse:min-h-11 cursor-pointer list-none items-center gap-1 font-medium text-foreground-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
          {own("all")}
          <ChevronDown className="size-3.5 transition-transform duration-150 group-open/legal:rotate-180" aria-hidden="true" />
        </summary>
        <div className="flex flex-col gap-3 pt-2">
          <ul className="flex flex-col gap-1.5">
            {LEGAL_PAGES.map((page) => (
              <li key={page.slug}>
                <Link href={`/legal/${page.slug}`} className={link}>
                  {t(`links.${page.key}`)}
                </Link>
              </li>
            ))}
            <li>
              <ConsentLink className="text-foreground-muted hover:text-foreground" />
            </li>
            <li>
              <Link href="/aide" className={link}>
                {t("help")}
              </Link>
            </li>
            <li>
              <Link href="/aide/contact" className={link}>
                {t("contact")}
              </Link>
            </li>
          </ul>
          <p className="text-pretty text-foreground-muted">{t("disclaimer")}</p>
          <p className="text-foreground-muted">{t("copyright", { year, publisher })}</p>
          <div className="flex flex-wrap items-center gap-2">
            <ThemeToggle className="w-fit" />
            <LocaleSwitcher className="border border-border md:hidden" />
          </div>
        </div>
      </details>
    </footer>
  );
}
