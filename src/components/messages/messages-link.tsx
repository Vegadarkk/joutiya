"use client";

import { MessageSquare } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { MESSAGES_LINK_CLASS } from "./messages-link-plain";
import { useMessagingStream } from "./use-live";

// Header link to /messages with the unread badge (design phase-5 D2, D3): its own chunk, loaded by
// the account menu once a member session is known. Mounted, it keeps the tab's stream open: first
// paint from GET /api/messages/unread, then the `unread` events.

/** "1".."99", then "99+". */
export function badgeText(total: number): string {
  return total > 99 ? "99+" : String(total);
}

export default function MessagesLink() {
  const t = useTranslations("Auth.menu");
  const { unread } = useMessagingStream();
  const total = unread ?? 0;
  const label = total > 0 ? `${t("messagesLink")}, ${t("unreadCount", { count: total })}` : t("messagesLink");
  return (
    <Link href="/messages" aria-label={label} data-testid="messages-link" data-unread={total} className={MESSAGES_LINK_CLASS}>
      <MessageSquare aria-hidden="true" />
      {total > 0 ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-1 end-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[0.6875rem] leading-none font-semibold text-primary-foreground tabular-nums",
            "ring-2 ring-surface",
          )}
        >
          {badgeText(total)}
        </span>
      ) : null}
    </Link>
  );
}
