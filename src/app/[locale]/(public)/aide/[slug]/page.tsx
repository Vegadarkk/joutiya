import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChevronRight } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { HELP_PAGES, HELP_SLUGS, helpCategories, helpArticle, helpValues, isHelpSlug, type HelpLink } from "@/content/help";
import { legalPage } from "@/config/legal-pages";
import type { Locale } from "@/config/site";
import { AssistantLauncher } from "@/components/help/assistant-launcher";
import { ArticleBody } from "@/components/help/article-body";
import { Container } from "@/components/layout/container";
import { quietLinkClassName } from "@/components/ui/text-link";
import { pageLocale } from "@/i18n/params";
import { alternates } from "@/lib/i18n/metadata";
import { getLegalConfig } from "@/lib/legal/config";
import { cn } from "@/lib/utils";

// One help article (design phase-5 D25), every locale and slug built ahead (ISR, 5 minutes: the
// listing lifetime comes from config/legal).
export const revalidate = 300;
export const dynamicParams = false;

export function generateStaticParams() {
  return HELP_SLUGS.map((slug) => ({ slug }));
}

type Params = Promise<{ locale: string; slug: string }>;

async function load(params: Params) {
  const { locale: raw, slug } = await params;
  const locale = pageLocale(raw);
  if (!isHelpSlug(slug)) notFound();
  return { locale, article: helpArticle(locale, slug, helpValues(await getLegalConfig())) };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, article } = await load(params);
  return { title: article.title, description: article.summary, alternates: alternates(locale, `/aide/${article.slug}`) };
}

async function linkLabels(locale: Locale) {
  const [pages, legal] = await Promise.all([getTranslations({ locale, namespace: "Help.pages" }), getTranslations({ locale, namespace: "Footer.links" })]);
  return (link: HelpLink, titleOf: (slug: HelpLink & { kind: "help" }) => string): { href: string; label: string } => {
    if (link.kind === "page") return { href: HELP_PAGES[link.page], label: pages(link.page) };
    if (link.kind === "legal") return { href: `/legal/${link.slug}`, label: legal(legalPage(link.slug)?.key ?? "cgu") };
    return { href: `/aide/${link.slug}`, label: titleOf(link) };
  };
}

export default async function HelpArticlePage({ params }: { params: Params }) {
  const { locale, article } = await load(params);
  setRequestLocale(locale);
  const [t, label, values] = await Promise.all([getTranslations({ locale, namespace: "Help" }), linkLabels(locale), getLegalConfig().then(helpValues)]);
  const category = helpCategories(locale)[article.category];
  const links = article.links.map((link) => label(link, (help) => helpArticle(locale, help.slug, values).title));

  return (
    <Container className="py-8 sm:py-12">
      <nav aria-label={t("breadcrumb")} className="mb-6 text-sm">
        <ol className="flex flex-wrap items-center gap-1.5 text-foreground-muted">
          <li>
            <Link href="/aide" className={cn("hover:text-foreground", quietLinkClassName)}>
              {t("home")}
            </Link>
          </li>
          <li aria-hidden="true">
            <ChevronRight className="size-3.5 rtl:-scale-x-100" />
          </li>
          <li>{category.title}</li>
        </ol>
      </nav>

      <article className="max-w-[68ch]">
        <header className="mb-8 flex flex-col gap-3">
          <h1 className="text-3xl font-semibold text-balance sm:text-4xl">{article.title}</h1>
          <p className="text-lg text-pretty text-foreground-muted">{article.summary}</p>
        </header>
        <ArticleBody blocks={article.blocks} locale={locale} />

        {links.length > 0 ? (
          <section aria-labelledby="help-related" className="mt-10 border-t border-border pt-6">
            <h2 id="help-related" className="mb-3 font-semibold">
              {t("related")}
            </h2>
            <ul className="flex flex-col gap-2">
              {links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className={cn("font-medium text-link", quietLinkClassName)}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </article>

      <aside aria-labelledby="help-still" className="arch mt-12 flex max-w-[68ch] flex-col gap-4 border-t-4 border-featured bg-surface-brand px-6 pt-10 pb-6 sm:px-8">
        <div className="flex flex-col gap-1.5">
          <h2 id="help-still" className="text-xl font-semibold">
            {t("stillTitle")}
          </h2>
          <p className="text-pretty text-foreground-muted">{t("stillBody")}</p>
        </div>
        <div>
          <AssistantLauncher />
        </div>
      </aside>
    </Container>
  );
}
