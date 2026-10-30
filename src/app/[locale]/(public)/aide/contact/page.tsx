import type { Metadata } from "next";
import { Flag, Landmark, Lock, Mail, Scale, type LucideIcon } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { DoorMark } from "@/components/feedback/door-mark";
import { Container } from "@/components/layout/container";
import { ReportReferenceForm } from "@/components/report/report-reference";
import { textLinkClassName } from "@/components/ui/text-link";
import { Link } from "@/i18n/navigation";
import { localeParams, pageLocale } from "@/i18n/params";
import { alternates } from "@/lib/i18n/metadata";
import { getLegalConfig } from "@/lib/legal/config";
import { dsaLanguages } from "@/lib/legal/values";
import { cn } from "@/lib/utils";

// "Nous contacter" (DSA art. 12, the users' single point of contact; Phase 6 legal review of 29 Oct
// 2026): the e-mail read by a person, the accepted languages, where to go for each case, and a way
// to report a content with no "Signaler" button in front of the person. No account needed, the
// assistant offered but never the only channel. ISR like the help centre: a change of config/legal
// reaches the page within 5 minutes.
export const revalidate = 300;

export function generateStaticParams() {
  return localeParams();
}

type Params = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Contact" });
  return { title: t("metaTitle"), description: t("metaDescription"), alternates: alternates(locale, "/aide/contact") };
}

const CASES: { key: "report" | "appeal" | "data" | "authorities"; icon: LucideIcon; href: string }[] = [
  { key: "report", icon: Flag, href: "#signaler" },
  { key: "appeal", icon: Scale, href: "/recours" },
  { key: "data", icon: Lock, href: "/legal/confidentialite#droits" },
  { key: "authorities", icon: Landmark, href: "/legal/contact-autorites" },
];

const link = cn("font-medium text-link", textLinkClassName);

/** An e-mail address as a mailto link, any other contact as plain text. */
function ContactValue({ value }: { value: string }) {
  if (!value) return null;
  return value.includes("@") ? (
    <a href={`mailto:${value}`} dir="ltr" className={cn("w-fit break-all", link)}>
      {value}
    </a>
  ) : (
    <span dir="ltr">{value}</span>
  );
}

export default async function ContactPage({ params }: { params: Params }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const [t, legal] = await Promise.all([getTranslations({ locale, namespace: "Contact" }), getLegalConfig()]);
  const languages = dsaLanguages(legal, locale === "ar" ? "ar" : "fr");

  return (
    <>
      <section className="border-b border-border bg-surface-brand/70">
        <Container className="grid items-end gap-8 pt-10 pb-12 sm:pt-14 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-16">
          <div className="flex max-w-2xl flex-col gap-4">
            <h1 className="text-3xl font-semibold text-balance sm:text-4xl">{t("title")}</h1>
            <p className="text-lg text-pretty text-foreground-muted">{t("lead", { languages })}</p>
          </div>
          <DoorMark className="hidden w-28 lg:block" />
        </Container>
      </section>

      <Container className="py-10 sm:py-12">
        <div className="flex max-w-5xl flex-col gap-10">
          <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:gap-12">
            <section id="email" aria-labelledby="contact-email" className="flex flex-col gap-4 self-start rounded-lg border border-border bg-surface-brand/60 p-6">
              <h2 id="contact-email" className="flex items-center gap-2 text-xl font-semibold">
                <Mail className="size-5 text-structure dark:text-gold-300" aria-hidden="true" />
                {t("email.title")}
              </h2>
              <a href={`mailto:${legal.dsaContactEmail}`} dir="ltr" className={cn("w-fit break-all text-2xl font-semibold", link)}>
                {legal.dsaContactEmail}
              </a>
              <dl className="flex flex-col gap-3 text-sm">
                <div className="flex flex-col gap-0.5">
                  <dt className="font-medium">{t("email.languages")}</dt>
                  <dd className="text-foreground-muted">{languages}</dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="font-medium">{t("email.person")}</dt>
                  <dd className="text-foreground-muted text-pretty">{t("email.personHint")}</dd>
                </div>
              </dl>
              <p className="text-sm text-foreground-muted text-pretty">
                {t("email.assistant")}{" "}
                <Link href="/aide" className={link}>
                  {t("email.assistantLink")}
                </Link>
              </p>
            </section>

            <section aria-labelledby="contact-cases" className="flex flex-col gap-5">
              <h2 id="contact-cases" className="text-xl font-semibold">
                {t("cases.title")}
              </h2>
              <ul className="grid gap-4 sm:grid-cols-2">
                {CASES.map(({ key, icon: Icon, href }) => (
                  <li key={key} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-5">
                    <h3 className="flex items-center gap-2 text-base font-semibold">
                      <Icon className="size-5 shrink-0 text-structure dark:text-gold-300" aria-hidden="true" />
                      {t(`cases.${key}.title`)}
                    </h3>
                    <p className="text-sm text-foreground-muted text-pretty">{t(`cases.${key}.body`)}</p>
                    {key === "data" ? (
                      <p className="text-sm">
                        <ContactValue value={legal.dpoContact} />
                      </p>
                    ) : null}
                    {href.startsWith("#") ? (
                      <a href={href} className={cn("mt-auto w-fit pt-1 text-sm", link)}>
                        {t(`cases.${key}.link`)}
                      </a>
                    ) : (
                      <Link href={href} className={cn("mt-auto w-fit pt-1 text-sm", link)}>
                        {t(`cases.${key}.link`)}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <section id="signaler" aria-labelledby="contact-report" className="arch flex scroll-mt-24 flex-col gap-4 border-t-4 border-featured bg-surface-brand px-6 pt-10 pb-6 sm:px-8">
            <h2 id="contact-report" className="text-xl font-semibold">
              {t("report.title")}
            </h2>
            <p className="max-w-2xl text-pretty text-foreground-muted">{t("report.body")}</p>
            <ReportReferenceForm email={legal.dsaContactEmail} className="max-w-2xl" />
          </section>

          <p className="text-sm text-foreground-muted text-pretty">
            {t("limits")}{" "}
            <Link href="/legal/contact-autorites#limites" className={link}>
              {t("limitsLink")}
            </Link>
          </p>
        </div>
      </Container>
    </>
  );
}
