import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ThreadView } from "@/components/messages/thread-view";
import { pageLocale } from "@/i18n/params";

// /messages/{cid}: one conversation, read in the browser from the messaging API (which checks
// that the session takes part in it). Only the id's shape is checked here.

type Props = { params: Promise<{ locale: string; cid: string }> };

const CID = /^[A-Za-z0-9_-]{22}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const locale = pageLocale((await params).locale);
  const t = await getTranslations({ locale, namespace: "Messaging.page" });
  return { title: t("title") };
}

export default async function ConversationPage({ params }: Props) {
  const { locale: raw, cid } = await params;
  const locale = pageLocale(raw);
  setRequestLocale(locale);
  if (!CID.test(cid)) notFound();
  return <ThreadView key={cid} cid={cid} />;
}
