import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ShieldCheck } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { GUIDE_GENERAL_SOURCES, GUIDE_RUBRICS, GUIDE_SOURCES, guideRubricCard, guideRubricPage, guideSourceLabel, rubricProcedures } from "@/content/guide";
import { LOCALE_TAGS } from "@/config/site";
import { DoorMark } from "@/components/feedback/door-mark";
import { GuideSearch, type GuideSearchEntry } from "@/components/guide/guide-search";
import { GuideDisclaimer, OfficialLink } from "@/components/guide/official-link";
import { Container } from "@/components/layout/container";
import { quietLinkClassName } from "@/components/ui/text-link";
import { localeParams, numbersLocale, pageLocale } from "@/i18n/params";
import { linkDisplay } from "@/lib/guide/check";
import { getGuideState } from "@/lib/guide/state";
import { alternates } from "@/lib/i18n/metadata";
import { cn } from "@/lib/utils";

// Admin procedures guide home, its own section /demarches (design guide-demarches G1, owner choice
// 28 Oct): the rubrics by visitor profile and the portals for every procedure. ISR, one hour: the
// weekly checker's state (system/guide-links) can withdraw or reveal a link.
export const revalidate = 3600;

export function generateStaticParams() {
  return localeParams();
}

type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Guide" });
  return { title: t("metaTitle"), description: t("metaDescription"), alternates: alternates(locale, "/demarches") };
}

export default async function GuideHome({ params }: { params: Params }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const [t, count, state] = await Promise.all([
    getTranslations({ locale, namespace: "Guide" }),
    // Prints a number: Tarifit pages format it as French (no Intl data for "rif").
    getTranslations({ locale: numbersLocale(locale), namespace: "Guide" }),
    getGuideState(),
  ]);
  const date = new Intl.DateTimeFormat(LOCALE_TAGS[numbersLocale(locale)], { dateStyle: "long", timeZone: "Africa/Casablanca" });
  const general = GUIDE_GENERAL_SOURCES.map((id) => ({ id, display: linkDisplay(GUIDE_SOURCES[id], state.links[id]) })).filter((link) => link.display !== "hidden");
  // Every procedure of the guide for the search field (journey review 2026-10-29), built with the page.
  const entries: GuideSearchEntry[] = GUIDE_RUBRICS.flatMap((rubric) => {
    const page = guideRubricPage(locale, rubric);
    return page.procedures.map((procedure) => ({ id: procedure.id, title: procedure.title, rubric, rubricTitle: page.title }));
  });

  return (
    <>
      <section className="border-b border-border bg-surface-brand/70">
        <Container className="grid items-end gap-8 pt-10 pb-12 sm:pt-14 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-16">
          <div className="flex max-w-2xl flex-col gap-4">
            <h1 className="text-3xl font-semibold text-balance sm:text-4xl">{t("title")}</h1>
            <p className="text-lg text-pretty text-foreground-muted">{t("lead")}</p>
            {state.runAt ? (
              <p className="flex items-center gap-2 text-sm text-foreground-muted">
                <ShieldCheck aria-hidden="true" className="size-4 shrink-0 text-structure dark:text-gold-300" />
                {t("checked", { date: date.format(new Date(state.runAt)) })}
              </p>
            ) : null}
          </div>
          <DoorMark className="hidden w-28 lg:block" />
        </Container>
      </section>

      <Container className="flex flex-col gap-12 py-10 sm:py-12">
        <GuideDisclaimer className="max-w-3xl" />

        <GuideSearch entries={entries} className="max-w-2xl" />

        <section aria-labelledby="guide-rubrics" className="max-w-4xl">
          <h2 id="guide-rubrics" className="mb-6 text-xl font-semibold">
            {t("rubricsTitle")}
          </h2>
          <ul className="grid gap-x-12 gap-y-8 md:grid-cols-2">
            {GUIDE_RUBRICS.map((rubric) => {
              const card = guideRubricCard(locale, rubric);
              return (
                <li key={rubric} className="flex flex-col gap-1.5 border-s-2 border-structure/70 ps-4 dark:border-gold-300/60">
                  <Link href={`/demarches/${rubric}`} className={cn("text-lg font-semibold text-link", quietLinkClassName)}>
                    {card.title}
                  </Link>
                  <p className="text-sm text-pretty text-foreground-muted">{card.summary}</p>
                  <p className="text-xs text-foreground-muted">{count("procedureCount", { count: rubricProcedures(rubric).length })}</p>
                </li>
              );
            })}
          </ul>
        </section>

        {general.length > 0 ? (
          <section aria-labelledby="guide-general" className="max-w-3xl">
            <h2 id="guide-general" className="mb-2 text-xl font-semibold">
              {t("generalTitle")}
            </h2>
            <ul className="divide-y divide-border">
              {general.map((link) => (
                <OfficialLink key={link.id} id={link.id} label={guideSourceLabel(locale, link.id)} display={link.display === "withdrawn" ? "withdrawn" : "live"} />
              ))}
            </ul>
          </section>
        ) : null}
      </Container>
    </>
  );
}
