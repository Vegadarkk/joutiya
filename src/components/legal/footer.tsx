import { useTranslations } from "next-intl";
import { ConsentLink } from "@/components/consent/consent-link";
import { Link } from "@/i18n/navigation";
import { LEGAL_PAGES } from "@/config/legal-pages";
import { Container } from "@/components/layout/container";
import { Logo } from "@/components/layout/logo";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { quietLinkClassName } from "@/components/ui/text-link";
import { cn } from "@/lib/utils";

/** Footer with the "Informations légales" column, Leboncoin's structure (brief §4). */
export function Footer({ publisher }: { publisher: string }) {
  const t = useTranslations("Footer");
  const year = new Date().getFullYear();
  const column = (name: "legal" | "trust") => LEGAL_PAGES.filter((page) => page.column === name);
  // Thin green line on top: the logo's door outline (bab-700); bab-600 in dark, where structure equals this background.
  return (
    <footer className="mt-auto border-t-2 border-structure bg-surface-brand text-foreground dark:border-bab-600">
      <Container className="grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr]">
        <div className="flex flex-col gap-4">
          <Logo label="Joutiya" className="h-12 w-fit" />
          <p className="max-w-xs text-sm text-pretty text-foreground-muted">{t("about")}</p>
          <ThemeToggle className="w-fit bg-background/40" />
        </div>
        <nav aria-labelledby="footer-legal">
          <h2 id="footer-legal" className="mb-4 font-semibold">
            {t("legalTitle")}
          </h2>
          <ul className="flex flex-col gap-2.5 text-sm">
            {column("legal").map((page) => (
              <li key={page.slug}>
                <Link href={`/legal/${page.slug}`} className={cn("text-foreground-muted hover:text-foreground", quietLinkClassName)}>
                  {t(`links.${page.key}`)}
                </Link>
              </li>
            ))}
            <li>
              <ConsentLink className="text-foreground-muted hover:text-foreground" />
            </li>
          </ul>
        </nav>
        <nav aria-labelledby="footer-trust">
          <h2 id="footer-trust" className="mb-4 font-semibold">
            {t("trustTitle")}
          </h2>
          <ul className="flex flex-col gap-2.5 text-sm">
            <li>
              <Link href="/aide" className={cn("text-foreground-muted hover:text-foreground", quietLinkClassName)}>
                {t("help")}
              </Link>
            </li>
            <li>
              <Link href="/aide/demarches" className={cn("text-foreground-muted hover:text-foreground", quietLinkClassName)}>
                {t("guide")}
              </Link>
            </li>
            {column("trust").map((page) => (
              <li key={page.slug}>
                <Link href={`/legal/${page.slug}`} className={cn("text-foreground-muted hover:text-foreground", quietLinkClassName)}>
                  {t(`links.${page.key}`)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </Container>
      <div className="border-t border-foreground/10">
        <Container className="flex flex-col gap-2 py-5 text-xs text-foreground-muted sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-pretty">{t("disclaimer")}</p>
          <p className="shrink-0">{t("copyright", { year, publisher })}</p>
        </Container>
      </div>
    </footer>
  );
}
