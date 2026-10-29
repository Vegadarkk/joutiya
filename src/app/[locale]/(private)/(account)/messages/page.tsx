import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ThreadPlaceholder } from "@/components/messages/thread-placeholder";
import { pageLocale } from "@/i18n/params";

// /messages: the list fills the screen below lg (layout.tsx); from lg this page is the thread
// pane next to it, neutral while the list is empty (thread-placeholder.tsx).

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Messaging.page" });
  return { title: t("title") };
}

export default async function MessagesPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = pageLocale((await params).locale);
  setRequestLocale(locale);
  return <ThreadPlaceholder />;
}
