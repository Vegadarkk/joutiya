import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { HELP_CATEGORIES, helpCategories } from "@/content/help";
import { DoorMark } from "@/components/feedback/door-mark";
import { AssistantLauncher } from "@/components/help/assistant-launcher";
import { HelpSearch, type HelpSearchEntry } from "@/components/help/help-search";
import { Container } from "@/components/layout/container";
import { quietLinkClassName, textLinkClassName } from "@/components/ui/text-link";
import { localeParams, numbersLocale, pageLocale } from "@/i18n/params";
import { loadHelpArticles } from "@/lib/help/search";
import { alternates } from "@/lib/i18n/metadata";
import { cn } from "@/lib/utils";

// Help centre home (design phase-5 D25): search over the locale's articles, the themes with their
// articles, and the Assistant Joutiya. ISR like the legal pages: a limit read from config/legal
// (the listing lifetime) reaches the text within 5 minutes.
export const revalidate = 300;

export function generateStaticParams() {
  return localeParams();
}

type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Help" });
  return { title: t("metaTitle"), description: t("metaDescription"), alternates: alternates(locale, "/aide") };
}

export default async function HelpHome({ params }: { params: Params }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const [t, guide, count, articles] = await Promise.all([
    getTranslations({ locale, namespace: "Help" }),
    getTranslations({ locale, namespace: "Guide" }),
    // Prints a number: Tarifit pages format it as French (no Intl data for "rif").
    getTranslations({ locale: numbersLocale(locale), namespace: "Help" }),
    loadHelpArticles(locale),
  ]);
  const categories = helpCategories(locale);
  const entries: HelpSearchEntry[] = articles.map((article) => ({
    slug: article.slug,
    title: article.title,
    summary: article.summary,
    keywords: article.keywords,
    category: categories[article.category].title,
  }));

  return (
    <>
      <section className="border-b border-border bg-surface-brand/70">
        <Container className="grid items-end gap-8 pt-10 pb-12 sm:pt-14 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-16">
          <div className="flex max-w-2xl flex-col gap-4">
            <h1 className="text-3xl font-semibold text-balance sm:text-4xl">{t("title")}</h1>
            <p className="text-lg text-pretty text-foreground-muted">{t("lead")}</p>
            <div className="mt-2">
              <AssistantLauncher />
            </div>
          </div>
          <DoorMark className="hidden w-28 lg:block" />
        </Container>
      </section>

      <Container className="py-10 sm:py-12">
        <div className="max-w-4xl">
          <HelpSearch entries={entries}>
            <section aria-labelledby="help-themes">
              <h2 id="help-themes" className="mb-6 text-xl font-semibold">
                {t("browse")}
              </h2>
              <div className="grid gap-x-12 gap-y-10 md:grid-cols-2">
                {HELP_CATEGORIES.map((category) => {
                  const inCategory = articles.filter((article) => article.category === category);
                  return (
                    <section key={category} aria-labelledby={`help-${category}`} className="flex flex-col gap-3 border-s-2 border-structure/70 ps-4 dark:border-gold-300/60">
                      <div className="flex flex-col gap-0.5">
                        <h3 id={`help-${category}`} className="text-lg font-semibold">
                          {categories[category].title}
                        </h3>
                        <p className="text-sm text-foreground-muted">
                          {categories[category].description} <span className="sr-only">({count("articleCount", { count: inCategory.length })})</span>
                        </p>
                      </div>
                      <ul className="flex flex-col gap-1.5">
                        {inCategory.map((article) => (
                          <li key={article.slug}>
                            <Link href={`/aide/${article.slug}`} className={cn("inline-flex min-h-8 items-center font-medium text-link", quietLinkClassName)}>
                              {article.title}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            </section>
          </HelpSearch>
          {/* Admin procedures guide (guide-demarches G1): official links by visitor profile. */}
          <aside aria-labelledby="help-guide" className="arch mt-12 flex flex-col gap-3 border-t-4 border-featured bg-surface-brand px-6 pt-10 pb-6 sm:px-8">
            <h2 id="help-guide" className="text-xl font-semibold">
              {guide("helpCardTitle")}
            </h2>
            <p className="max-w-2xl text-pretty text-foreground-muted">{guide("helpCardBody")}</p>
            <Link href="/demarches" className={cn("w-fit font-medium text-link", textLinkClassName)}>
              {guide("helpCardCta")}
            </Link>
          </aside>
        </div>
      </Container>
    </>
  );
}
