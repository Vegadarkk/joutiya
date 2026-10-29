import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { GUIDE_RUBRICS, GUIDE_SOURCES, guideRubricCard, guideRubricPage, guideSourceLabel, isGuideRubric } from "@/content/guide";
import { LOCALE_TAGS } from "@/config/site";
import { GuideDisclaimer, OfficialLink } from "@/components/guide/official-link";
import { Container } from "@/components/layout/container";
import { quietLinkClassName } from "@/components/ui/text-link";
import { localeParams, numbersLocale, pageLocale } from "@/i18n/params";
import { linkDisplay } from "@/lib/guide/check";
import { getGuideState } from "@/lib/guide/state";
import { alternates } from "@/lib/i18n/metadata";
import { cn } from "@/lib/utils";

// One rubric of the admin procedures guide (design guide-demarches G1): its procedures, each with
// what to prepare and its official links (G2), the disclaimer (G3) and the dates of the last check
// and the last human review. Every locale and rubric built ahead, ISR one hour (the checker's state).
export const revalidate = 3600;
export const dynamicParams = false;

export function generateStaticParams() {
  return localeParams(GUIDE_RUBRICS.map((rubric) => ({ rubric })));
}

type Params = Promise<{ locale: string; rubric: string }>;

async function load(params: Params) {
  const { locale: raw, rubric } = await params;
  const locale = pageLocale(raw);
  if (!isGuideRubric(rubric)) notFound();
  return { locale, page: guideRubricPage(locale, rubric) };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, page } = await load(params);
  return { title: page.title, description: page.summary, alternates: alternates(locale, `/demarches/${page.rubric}`) };
}

export default async function GuideRubricPage({ params }: { params: Params }) {
  const { locale, page } = await load(params);
  setRequestLocale(locale);
  const [t, state] = await Promise.all([getTranslations({ locale, namespace: "Guide" }), getGuideState()]);
  const date = new Intl.DateTimeFormat(LOCALE_TAGS[numbersLocale(locale)], { dateStyle: "long", timeZone: "Africa/Casablanca" });
  const procedures = page.procedures
    .map((procedure) => ({
      ...procedure,
      links: procedure.sources.map((id) => ({ id, display: linkDisplay(GUIDE_SOURCES[id], state.links[id]) })).filter((link) => link.display !== "hidden"),
    }))
    .filter((procedure) => procedure.links.length > 0);
  const others = GUIDE_RUBRICS.filter((rubric) => rubric !== page.rubric).map((rubric) => guideRubricCard(locale, rubric));

  return (
    <Container className="py-8 sm:py-12">
      <nav aria-label={t("breadcrumb")} className="mb-6 text-sm">
        <ol className="flex flex-wrap items-center gap-1.5 text-foreground-muted">
          <li>
            <Link href="/demarches" className={cn("hover:text-foreground", quietLinkClassName)}>
              {t("guideHome")}
            </Link>
          </li>
        </ol>
      </nav>

      <div className="grid gap-12 lg:grid-cols-[minmax(0,68ch)_minmax(0,18rem)] lg:justify-between">
        <article className="flex min-w-0 flex-col gap-8">
          <header className="flex flex-col gap-3">
            <h1 className="text-3xl font-semibold text-balance sm:text-4xl">{page.title}</h1>
            <p className="text-lg text-pretty text-foreground-muted">{page.intro}</p>
          </header>
          <GuideDisclaimer />

          {procedures.map((procedure) => (
            <section key={procedure.id} aria-labelledby={`procedure-${procedure.id}`} className="flex flex-col gap-3 border-t border-border pt-6">
              <h2 id={`procedure-${procedure.id}`} className="text-xl font-semibold text-balance">
                {procedure.title}
              </h2>
              {procedure.body.map((paragraph) => (
                <p key={paragraph} className="leading-7 text-pretty">
                  {paragraph}
                </p>
              ))}
              {procedure.prepare.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <h3 className="text-sm font-semibold">{t("prepare")}</h3>
                  <ul className="flex list-disc flex-col gap-1 ps-5 text-sm marker:text-featured">
                    {procedure.prepare.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="rounded-lg bg-surface-muted/60 px-4 py-1">
                <h3 className="sr-only">{t("officialLinks")}</h3>
                <ul className="divide-y divide-border">
                  {procedure.links.map((link) => (
                    <OfficialLink key={link.id} id={link.id} label={guideSourceLabel(locale, link.id)} display={link.display === "withdrawn" ? "withdrawn" : "live"} />
                  ))}
                </ul>
              </div>
            </section>
          ))}

          <footer className="flex flex-col gap-1 border-t border-border pt-6 text-sm text-foreground-muted">
            {state.runAt ? <p>{t("checked", { date: date.format(new Date(state.runAt)) })}</p> : null}
            {page.reviewedAt ? <p>{t("reviewed", { date: date.format(new Date(`${page.reviewedAt}T12:00:00Z`)) })}</p> : null}
          </footer>
        </article>

        <nav aria-labelledby="guide-others" className="flex flex-col gap-3 self-start lg:sticky lg:top-24">
          <h2 id="guide-others" className="font-semibold">
            {t("otherRubrics")}
          </h2>
          <ul className="flex flex-col gap-2 border-s-2 border-structure/70 ps-4 dark:border-gold-300/60">
            {others.map((other) => (
              <li key={other.rubric}>
                <Link href={`/demarches/${other.rubric}`} className={cn("inline-flex min-h-8 items-center font-medium text-link", quietLinkClassName)}>
                  {other.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </Container>
  );
}
