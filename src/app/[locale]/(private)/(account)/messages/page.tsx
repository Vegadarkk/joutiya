import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { DoorMark } from "@/components/feedback/door-mark";
import { pageLocale } from "@/i18n/params";

// /messages: the list fills the screen below lg (layout.tsx); from lg this page is the empty
// thread pane next to it.

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Messaging.page" });
  return { title: t("title") };
}

export default async function MessagesPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Messaging.page" });
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <DoorMark className="w-16 opacity-90" />
      <h2 className="text-lg font-semibold text-balance">{t("selectTitle")}</h2>
      <p className="max-w-xs text-sm text-foreground-muted text-pretty">{t("selectBody")}</p>
    </div>
  );
}
