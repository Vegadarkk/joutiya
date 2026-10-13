import { use } from "react";
import type { Metadata } from "next";
import { HandCoins, MapPinned, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { Container } from "@/components/layout/container";
import { SearchPanel } from "@/components/home/search-panel";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { alternates } from "@/lib/i18n/metadata";
import { pageLocale } from "@/i18n/params";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  return { alternates: alternates(pageLocale(locale)) };
}

const PILLARS = [
  { key: "free", icon: HandCoins },
  { key: "near", icon: MapPinned },
  { key: "safe", icon: ShieldCheck },
] as const;

export default function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale(use(params).locale);
  setRequestLocale(locale);
  const t = useTranslations("Home");
  return (
    <>
      <Container className="pt-6 sm:pt-10">
        <SearchPanel locale={locale} />
      </Container>
      <Container className="py-10 sm:py-14">
        <ErrorBanner tone="info" title={t("openingTitle")}>
          {t("openingBody")}
        </ErrorBanner>
        <ul className="mt-10 grid gap-8 sm:grid-cols-3">
          {PILLARS.map(({ key, icon: Icon }) => (
            <li key={key} className="flex gap-4">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-brand text-structure dark:text-gold-300">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <div>
                <h2 className="font-semibold">{t(`pillars.${key}.title`)}</h2>
                <p className="mt-1 text-sm text-foreground-muted">{t(`pillars.${key}.body`)}</p>
              </div>
            </li>
          ))}
        </ul>
      </Container>
    </>
  );
}
