"use client";

import { useId, useState } from "react";
import { Boxes } from "lucide-react";
import { useTranslations } from "next-intl";
import { Dialog } from "radix-ui";
import { toast } from "sonner";
import { useApiErrorMessage } from "@/components/auth/form-message";
import { useVariantLabels } from "@/components/post/variant-labels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { STOCK_MAX, isSoldOut, stockState, type ListingVariants } from "@/lib/contracts/catalog";
import { isolate } from "@/lib/i18n/bidi";
import { saveStock } from "@/lib/listings/client/api";
import { parsePriceInput } from "@/lib/listings/client/format";
import { cn } from "@/lib/utils";

// "Mes annonces" row of a Pro listing (catalogue §3): its declared stock at a glance, and a dialog
// that sets it alone (one write, no new moderation). Joutiya never counts sales: the Pro does.

type Catalogue = { stock: number | null; variants: ListingVariants | null };

/** Digits typed in a stock box: "" is « non suivi » (null). */
function parseStock(text: string): number | null {
  const parsed = parsePriceInput(text);
  return parsed === null ? null : Math.min(parsed, STOCK_MAX);
}

export function OwnerStock({ listingId, title, catalogue: initial }: { listingId: string; title: string; catalogue: Catalogue }) {
  const t = useTranslations("MyListings.stock");
  const [catalogue, setCatalogue] = useState(initial);
  const [open, setOpen] = useState(false);
  const summary = stockSummary(catalogue);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <p className={cn("text-xs text-pretty", summary.tone === "danger" ? "font-medium text-danger" : summary.tone === "warning" ? "font-medium text-warning" : "text-foreground-muted")} data-testid="owner-stock">
        {t(summary.key, summary.values)}
      </p>
      <Button type="button" variant="outline" size="sm" className="max-sm:h-11" aria-label={t("openOf", { title: isolate(title) })} onClick={() => setOpen(true)}>
        <Boxes aria-hidden="true" />
        {t("open")}
      </Button>
      {open ? <StockDialog listingId={listingId} title={title} catalogue={catalogue} onClose={() => setOpen(false)} onSaved={setCatalogue} /> : null}
    </div>
  );
}

type Summary = { key: "untracked" | "soldOut" | "count" | "low" | "variants" | "variantsSoldOut"; values: Record<string, number>; tone: "muted" | "warning" | "danger" };

/** The one line of the row: what a buyer reads on the listing, from the Pro's side. */
export function stockSummary(catalogue: Catalogue): Summary {
  if (catalogue.variants) {
    const items = catalogue.variants.items;
    const out = items.filter((item) => item.stock === 0).length;
    if (isSoldOut({ variants: catalogue.variants })) return { key: "soldOut", values: {}, tone: "danger" };
    return out > 0 ? { key: "variantsSoldOut", values: { count: items.length, out }, tone: "warning" } : { key: "variants", values: { count: items.length }, tone: "muted" };
  }
  switch (stockState(catalogue.stock)) {
    case "untracked":
      return { key: "untracked", values: {}, tone: "muted" };
    case "sold_out":
      return { key: "soldOut", values: {}, tone: "danger" };
    case "low":
      return { key: "low", values: { count: catalogue.stock ?? 0 }, tone: "warning" };
    case "in_stock":
      return { key: "count", values: { count: catalogue.stock ?? 0 }, tone: "muted" };
  }
}

interface StockDialogProps {
  listingId: string;
  title: string;
  catalogue: Catalogue;
  onClose: () => void;
  onSaved: (catalogue: Catalogue) => void;
}

function StockDialog({ listingId, title, catalogue, onClose, onSaved }: StockDialogProps) {
  const t = useTranslations("MyListings.stock");
  const apiMessage = useApiErrorMessage();
  const names = useVariantLabels();
  const descriptionId = useId();
  const [stock, setStock] = useState<number | null>(catalogue.stock);
  const [items, setItems] = useState(() => new Map((catalogue.variants?.items ?? []).map((item) => [item.key, item.stock ?? null])));
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const response = await saveStock(listingId, catalogue.variants ? { items: [...items].map(([key, value]) => ({ key, stock: value })) } : { stock });
      toast.success(t("saved"));
      onSaved({ stock: response.listing.stock, variants: response.listing.variants });
      onClose();
    } catch (error) {
      toast.error(apiMessage(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(value) => !value && !saving && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={descriptionId}
          data-testid="stock-dialog"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-lg border border-border bg-surface shadow-xl shadow-bab-950/20 outline-none",
            "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:max-h-[88dvh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg rtl:sm:translate-x-1/2",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <div className="flex flex-col gap-1.5 border-b border-border px-5 pt-5 pb-4 sm:px-6">
            <Dialog.Title className="text-lg font-semibold text-balance">{t("title", { title: isolate(title) })}</Dialog.Title>
            <Dialog.Description id={descriptionId} className="text-sm text-foreground-muted text-pretty">
              {t("hint")}
            </Dialog.Description>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4 sm:px-6">
            {catalogue.variants ? (
              <ul className="flex flex-col divide-y divide-border">
                {catalogue.variants.items.map((item) => {
                  const name = names.combination(catalogue.variants!.axes, item.key);
                  const value = items.get(item.key) ?? null;
                  return (
                    <li key={item.key} className="flex items-center justify-between gap-3 py-2">
                      <span className={cn("min-w-0 font-medium", value === 0 && "text-foreground-muted")}>{name}</span>
                      <StockBox label={t("stockOf", { name })} value={value} onChange={(next) => setItems((current) => new Map(current).set(item.key, next))} />
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="flex items-center justify-between gap-3 py-2">
                <span className="font-medium">{t("stock")}</span>
                <StockBox label={t("stock")} value={stock} onChange={setStock} />
              </div>
            )}
            <p className="pt-3 text-sm text-foreground-muted">{t("emptyHint")}</p>
          </div>

          <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
            <Dialog.Close asChild>
              <Button type="button" variant="outline" disabled={saving}>
                {t("cancel")}
              </Button>
            </Dialog.Close>
            <Button type="button" loading={saving} onClick={() => void save()}>
              {t("save")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function StockBox({ label, value, onChange }: { label: string; value: number | null; onChange: (value: number | null) => void }) {
  const t = useTranslations("MyListings.stock");
  return (
    <Input
      type="text"
      inputMode="numeric"
      dir="ltr"
      autoComplete="off"
      aria-label={label}
      placeholder={t("untrackedShort")}
      className="w-28 shrink-0 text-end tabular-nums"
      value={value === null ? "" : String(value)}
      onChange={(event) => onChange(parseStock(event.target.value))}
    />
  );
}
