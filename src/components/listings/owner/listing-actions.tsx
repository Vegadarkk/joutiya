"use client";

import { useState } from "react";
import { Eye, MoreHorizontal, Pause, Pencil, Play, RefreshCw, Tag, Trash2, TrendingUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { DropdownMenu } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import type { OwnerListingSummary } from "@/lib/contracts/listings";
import { isolate } from "@/lib/i18n/bidi";
import type { OwnerAction } from "@/lib/listings/client/api";
import { wizardPath } from "@/lib/listings/client/routes";
import { cn } from "@/lib/utils";
import { canResume } from "./buckets";
import { ConfirmDialog } from "@/components/post/controls/confirm-dialog";
import { PromoteDialog } from "@/components/payments/promote-dialog";

interface ListingActionsProps {
  listing: OwnerListingSummary;
  onAction: (action: OwnerAction) => Promise<void>;
  onDelete: () => Promise<void>;
  busy?: boolean;
  /** Localized path of the public page (published listings). */
  publicHref?: string | null;
  /** Paid options are on sale (config/flags.salesEnabled): published listings offer "Mettre en avant". */
  salesOpen?: boolean;
  now?: Date;
}

export { canResume };

/** Which actions a status allows (design D16 and the lifecycle table). */
export function allowedActions(listing: OwnerListingSummary, now = new Date()): { edit: boolean; view: boolean; pause: boolean; resume: boolean; sold: boolean; renew: boolean; remove: boolean } {
  const { status } = listing;
  return {
    edit: status === "draft" || status === "published" || status === "paused" || status === "pending_review" || status === "rejected" || status === "expired",
    view: status === "published" && Boolean(listing.slugId),
    pause: status === "published",
    resume: canResume(listing, now),
    sold: status === "published" || status === "paused",
    renew: listing.canRenew && (status === "published" || status === "expired"),
    remove: status !== "removed" && status !== "purged",
  };
}

export function ListingActions({ listing, onAction, onDelete, busy, publicHref, salesOpen = false, now }: ListingActionsProps) {
  const t = useTranslations("MyListings");
  const [confirm, setConfirm] = useState<"delete" | "sold" | null>(null);
  const [promote, setPromote] = useState(false);
  const [working, setWorking] = useState(false);
  const allowed = allowedActions(listing, now);
  // The seller's title keeps its own direction inside the translated labels.
  const title = isolate(listing.title || t("untitled"));
  const item = cn("flex min-h-11 cursor-pointer items-center gap-2.5 rounded-sm px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-muted [&_svg]:size-4 [&_svg]:text-foreground-muted");

  async function run(fn: () => Promise<void>) {
    setWorking(true);
    try {
      await fn();
    } finally {
      setWorking(false);
      setConfirm(null);
    }
  }

  return (
    <>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <Button type="button" variant="ghost" size="icon" aria-label={t("actions.menu", { title })} loading={busy || working}>
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-56 rounded-md border border-border bg-surface p-1 shadow-lg shadow-bab-950/10 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
            {allowed.view && publicHref ? (
              <DropdownMenu.Item asChild>
                <a href={publicHref} className={item}>
                  <Eye aria-hidden="true" />
                  {t("actions.view")}
                </a>
              </DropdownMenu.Item>
            ) : null}
            {allowed.edit ? (
              <DropdownMenu.Item asChild>
                <Link href={wizardPath(listing.id)} className={item}>
                  <Pencil aria-hidden="true" />
                  {listing.status === "draft" ? t("actions.continueDraft") : t("actions.edit")}
                </Link>
              </DropdownMenu.Item>
            ) : null}
            {salesOpen && listing.status === "published" ? (
              <DropdownMenu.Item className={item} onSelect={() => setPromote(true)}>
                <TrendingUp aria-hidden="true" />
                {t("actions.promote")}
              </DropdownMenu.Item>
            ) : null}
            {allowed.pause ? (
              <DropdownMenu.Item className={item} onSelect={() => void run(() => onAction("pause"))}>
                <Pause aria-hidden="true" />
                {t("actions.pause")}
              </DropdownMenu.Item>
            ) : null}
            {allowed.resume ? (
              <DropdownMenu.Item className={item} onSelect={() => void run(() => onAction("resume"))}>
                <Play aria-hidden="true" />
                {t("actions.resume")}
              </DropdownMenu.Item>
            ) : null}
            {allowed.renew ? (
              <DropdownMenu.Item className={item} onSelect={() => void run(() => onAction("renew"))}>
                <RefreshCw aria-hidden="true" />
                {t("actions.renew")}
              </DropdownMenu.Item>
            ) : null}
            {allowed.sold ? (
              <DropdownMenu.Item className={item} onSelect={() => setConfirm("sold")}>
                <Tag aria-hidden="true" />
                {t("actions.sold")}
              </DropdownMenu.Item>
            ) : null}
            {allowed.remove ? (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item className={cn(item, "text-danger [&_svg]:text-danger")} onSelect={() => setConfirm("delete")}>
                  <Trash2 aria-hidden="true" />
                  {t("actions.delete")}
                </DropdownMenu.Item>
              </>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {salesOpen && promote ? <PromoteDialog listingId={listing.id} title={listing.title || t("untitled")} onClose={() => setPromote(false)} /> : null}
      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t("confirm.deleteTitle")}
        body={t("confirm.deleteBody", { title })}
        cancelLabel={t("confirm.cancel")}
        confirmLabel={t("confirm.confirmDelete")}
        loading={working}
        onConfirm={() => void run(onDelete)}
      />
      <ConfirmDialog
        open={confirm === "sold"}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={t("confirm.soldTitle", { title })}
        body={t("confirm.soldBody")}
        cancelLabel={t("confirm.cancel")}
        confirmLabel={t("confirm.confirmSold")}
        tone="primary"
        loading={working}
        onConfirm={() => void run(() => onAction("sold"))}
      />
    </>
  );
}
