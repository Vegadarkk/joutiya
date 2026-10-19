"use client";

import { MessageSquare } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

// The header's messages link without its badge: what renders while the badge chunk
// (messages-link.tsx) loads, or for good if it cannot be downloaded. Kept apart so the account
// menu (first JavaScript of every page) does not pull the live client.

export const MESSAGES_LINK_CLASS = "relative inline-flex size-11 items-center justify-center rounded-md text-foreground hover:bg-surface-muted [&_svg]:size-[1.15rem]";

export function MessagesLinkPlain() {
  const t = useTranslations("Auth.menu");
  return (
    <Link href="/messages" aria-label={t("messagesLink")} className={MESSAGES_LINK_CLASS}>
      <MessageSquare aria-hidden="true" />
    </Link>
  );
}
