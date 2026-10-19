"use client";

import { useState } from "react";
import { Archive, ArchiveRestore, Ban, CircleCheck, EllipsisVertical, Flag, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { DropdownMenu } from "radix-ui";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/post/controls/confirm-dialog";
import { buttonVariants } from "@/components/ui/button";
import type { ConversationStateRequest, ConversationView } from "@/lib/contracts/messaging";
import { isolate } from "@/lib/i18n/bidi";
import { changeConversationState } from "@/lib/messaging/client";
import { cn } from "@/lib/utils";
import { useMessagingErrorMessage } from "./errors";

// The thread's menu (design phase-5 D6, D7, D10): archive or unarchive, block or unblock the other
// participant (account wide), report them (the notice form, opened by the thread), delete for me.
// Blocking and deleting ask first; every action is allowed to a suspended account (D9).

export type ThreadAction = "archive" | "unarchive" | "block" | "unblock" | "delete";

/** The state change each action posts. */
export function stateChangeOf(action: ThreadAction): ConversationStateRequest {
  switch (action) {
    case "archive":
      return { archived: true };
    case "unarchive":
      return { archived: false };
    case "block":
      return { blocked: true };
    case "unblock":
      return { blocked: false };
    case "delete":
      return { hidden: true };
  }
}

/** The conversation as it reads after `action` succeeded (delete: the caller leaves the thread). */
export function afterAction(conversation: ConversationView, action: ThreadAction): ConversationView {
  switch (action) {
    case "archive":
    case "unarchive":
      return { ...conversation, archived: action === "archive" };
    case "block":
    case "unblock":
      return { ...conversation, blockedByMe: action === "block" };
    case "delete":
      return { ...conversation, unread: 0 };
  }
}

export interface ThreadActionsProps {
  conversation: ConversationView;
  onDone: (action: ThreadAction, conversation: ConversationView) => void;
  /** Opens the notice form about the other participant. */
  onReport: () => void;
}

export function ThreadActions({ conversation, onDone, onReport }: ThreadActionsProps) {
  const t = useTranslations("Messaging.thread");
  const report = useTranslations("Report.trigger");
  const errorMessage = useMessagingErrorMessage();
  const [confirm, setConfirm] = useState<"block" | "delete" | null>(null);
  const [busy, setBusy] = useState<ThreadAction | null>(null);
  const name = isolate(conversation.counterpart.displayName);

  async function run(action: ThreadAction) {
    if (busy) return;
    setBusy(action);
    try {
      await changeConversationState(conversation.cid, stateChangeOf(action));
      setConfirm(null);
      const toasts: Record<ThreadAction, string> = {
        archive: t("archivedToast"),
        unarchive: t("unarchivedToast"),
        block: t("blockedToast", { name }),
        unblock: t("unblockedToast", { name }),
        delete: t("deletedToast"),
      };
      toast.success(toasts[action]);
      onDone(action, afterAction(conversation, action));
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const item = cn(
    "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-sm px-3 py-2.5 text-sm outline-none",
    "data-[highlighted]:bg-surface-muted [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-foreground-muted",
  );
  return (
    <>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger aria-label={t("actions")} className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "shrink-0 data-[state=open]:bg-surface-muted")}>
          <EllipsisVertical aria-hidden="true" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className={cn(
              "z-50 min-w-60 rounded-md border border-border bg-surface p-1 shadow-lg shadow-bab-950/10",
              "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            )}
          >
            <DropdownMenu.Item className={item} disabled={busy !== null} onSelect={() => void run(conversation.archived ? "unarchive" : "archive")}>
              {conversation.archived ? <ArchiveRestore aria-hidden="true" /> : <Archive aria-hidden="true" />}
              {conversation.archived ? t("unarchive") : t("archive")}
            </DropdownMenu.Item>
            <DropdownMenu.Item className={item} disabled={busy !== null} onSelect={() => (conversation.blockedByMe ? void run("unblock") : setConfirm("block"))}>
              {conversation.blockedByMe ? <CircleCheck aria-hidden="true" /> : <Ban aria-hidden="true" />}
              <span dir="auto">{conversation.blockedByMe ? t("unblock", { name }) : t("block", { name })}</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={item} onSelect={onReport}>
              <Flag aria-hidden="true" />
              <span dir="auto">{report("conversation", { name })}</span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item className={cn(item, "text-danger [&_svg]:text-danger")} disabled={busy !== null} onSelect={() => setConfirm("delete")}>
              <Trash2 aria-hidden="true" />
              {t("delete")}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ConfirmDialog
        open={confirm === "block"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t("blockTitle", { name })}
        body={t("blockBody")}
        cancelLabel={t("cancel")}
        confirmLabel={t("blockConfirm")}
        loading={busy === "block"}
        onConfirm={() => void run("block")}
      />
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t("deleteTitle")}
        body={t("deleteBody", { name })}
        cancelLabel={t("cancel")}
        confirmLabel={t("deleteConfirm")}
        loading={busy === "delete"}
        onConfirm={() => void run("delete")}
      />
    </>
  );
}
