"use client";

import type { ReactNode } from "react";
import { useSelectedLayoutSegment } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Inbox } from "./inbox";
import { MessagesProvider } from "./messages-provider";

// The messaging panel (design phase-5 D2): the conversation list and the open thread side by side
// from lg, one at a time below (the list at /messages, the thread at /messages/{cid}). The panel
// fills the viewport under the sticky header so the thread scrolls inside it, composer at the bottom.

/** The open conversation id from the child segment, null on /messages itself. */
export function selectedConversation(segment: string | null): string | null {
  return segment && !segment.startsWith("__") ? segment : null;
}

export function MessagesShell({ children }: { children: ReactNode }) {
  const t = useTranslations("Messaging.page");
  const selected = selectedConversation(useSelectedLayoutSegment());
  return (
    <MessagesProvider>
      <div
        className={cn(
          "flex h-[calc(100dvh-4rem)] min-h-[26rem] w-full overflow-hidden bg-surface md:h-[calc(100dvh-5rem)]",
          "lg:h-[calc(100dvh-8rem)] lg:rounded-lg lg:border lg:border-border lg:shadow-sm",
        )}
      >
        <aside className={cn("min-h-0 min-w-0 flex-col lg:flex lg:w-[22rem] lg:shrink-0 lg:border-e lg:border-border xl:w-96", selected ? "hidden" : "flex flex-1 lg:flex-none")}>
          <Inbox selected={selected} />
        </aside>
        <section className={cn("min-h-0 min-w-0 flex-1 flex-col bg-background lg:flex", selected ? "flex" : "hidden")}>
          {/* Below lg the list (and its h1) is hidden while a thread is open. */}
          {selected ? <h1 className="sr-only lg:hidden">{t("title")}</h1> : null}
          {children}
        </section>
      </div>
    </MessagesProvider>
  );
}
