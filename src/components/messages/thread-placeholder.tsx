"use client";

import { useTranslations } from "next-intl";
import { DoorMark } from "@/components/feedback/door-mark";
import { inboxIsEmpty } from "./inbox-state";
import { useMessages } from "./messages-provider";

// The thread pane of /messages itself (from lg, beside the list). One empty state at a time (UX
// audit, finding 7): while the list is empty it already says so, with "Parcourir les annonces", so
// this pane stays neutral (the door alone); it invites to pick a conversation only once there is
// one. Same neutral pane while the list loads, so nothing flashes.

export function ThreadPlaceholder() {
  const { inbox } = useMessages();
  return <ThreadPlaceholderView quiet={inbox.kind === "loading" || inboxIsEmpty(inbox)} />;
}

export function ThreadPlaceholderView({ quiet }: { quiet: boolean }) {
  const t = useTranslations("Messaging.page");
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center" data-testid="thread-placeholder" data-quiet={quiet ? "1" : "0"}>
      <DoorMark className={quiet ? "w-16 opacity-40" : "w-16 opacity-90"} />
      {quiet ? null : (
        <>
          <h2 className="text-lg font-semibold text-balance">{t("selectTitle")}</h2>
          <p className="max-w-xs text-sm text-foreground-muted text-pretty">{t("selectBody")}</p>
        </>
      )}
    </div>
  );
}
