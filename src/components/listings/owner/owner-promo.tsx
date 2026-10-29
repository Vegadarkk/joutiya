"use client";

import { useId, useState } from "react";
import { BadgePercent, Info, ShieldCheck } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Dialog } from "radix-ui";
import { toast } from "sonner";
import { useApiErrorMessage } from "@/components/auth/form-message";
import { ChipRadioGroup } from "@/components/post/controls/chips";
import { useVariantLabels } from "@/components/post/variant-labels";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SITE_NAME, type Locale } from "@/config/site";
import { moroccoClock, moroccoTime } from "@/lib/appointments/time";
import { isApiError } from "@/lib/auth/client";
import {
  FLASH_MAX_MS,
  PROMO_KINDS,
  PROMO_MAX_MS,
  PROMO_PERCENT_MAX,
  PROMO_REVIEW_PERCENT,
  percentOff,
  promoRunning,
  type PromoInput,
  type PromoKind,
} from "@/lib/contracts/catalog";
import type { OwnerCatalogue, OwnerListingSummary } from "@/lib/contracts/listings";
import { isolate } from "@/lib/i18n/bidi";
import { moroccoTimeZone } from "@/lib/i18n/morocco-time";
import { endPromo, savePromo } from "@/lib/listings/client/api";
import { formatPrice, intlLocale, parsePriceInput } from "@/lib/listings/client/format";
import { cn } from "@/lib/utils";

// "Mes annonces" row of a published or paused Pro listing (catalogue §4): its promotion at a
// glance, and a dialog that launches one (kind, cut, period, preview against the struck-out price
// Joutiya computed) or stops the current one. The server re-checks every rule (planPromo).

const DAY_MS = 24 * 60 * 60 * 1000;
const PROMO_ROW_STATUSES: readonly OwnerListingSummary["status"][] = ["published", "paused"];

export function showsPromo(listing: OwnerListingSummary): boolean {
  return listing.catalogue !== undefined && listing.price !== null && PROMO_ROW_STATUSES.includes(listing.status);
}

/** A date and time on Morocco's wall clock, as the listing page shows the promotion's period. */
function useDateTime(): (at: number | string) => string {
  const locale = useLocale() as Locale;
  return (at) => {
    const ms = new Date(at).getTime();
    return new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: moroccoTimeZone(ms) }).format(ms);
  };
}

interface OwnerPromoProps {
  listing: OwnerListingSummary & { catalogue: OwnerCatalogue };
  title: string;
  now: Date;
  onChanged: (listing: OwnerListingSummary) => void;
}

export function OwnerPromo({ listing, title, now, onChanged }: OwnerPromoProps) {
  const t = useTranslations("MyListings.promo");
  const dateTime = useDateTime();
  const [open, setOpen] = useState(false);
  const promo = listing.catalogue.promo;
  const running = promoRunning(promo, now.getTime());
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {promo ? (
        <p data-testid="owner-promo" data-state={running ? "running" : "scheduled"} className={cn("text-xs font-medium text-pretty", running ? "text-danger" : "text-foreground-muted")}>
          {running ? t("running", { kind: t(`kinds.${promo.kind}`), end: dateTime(promo.endsAt) }) : t("scheduled", { kind: t(`kinds.${promo.kind}`), start: dateTime(promo.startsAt), end: dateTime(promo.endsAt) })}
        </p>
      ) : null}
      <Button type="button" variant="outline" size="sm" className="max-sm:h-11" aria-label={t("openOf", { title: isolate(title) })} onClick={() => setOpen(true)}>
        <BadgePercent aria-hidden="true" />
        {t("open")}
      </Button>
      {open ? <PromoDialog listing={listing} title={title} now={now} onClose={() => setOpen(false)} onChanged={onChanged} /> : null}
    </div>
  );
}

/** "YYYY-MM-DDTHH:mm" on Morocco's wall clock (the value of a datetime-local input), whatever the device's zone. */
export function localInput(at: number): string {
  const { day, minutes } = moroccoClock(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${day}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function parseLocalInput(value: string): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value);
  return match ? moroccoTime(match[1]!, Number(match[2]) * 60 + Number(match[3])) : null;
}

/** A promotional price as the server computes it from a percentage. */
export function promoPriceOf(before: number, percent: number): number {
  return Math.max(1, Math.floor((before * (100 - percent)) / 100));
}

/** The issue the server named (`details` of a 400), translated, or null. */
function promoIssue(error: unknown): { code: string; value?: string } | null {
  if (!isApiError(error, "invalid_body") || !Array.isArray(error.details)) return null;
  const first = error.details[0] as { code?: unknown; value?: unknown } | undefined;
  return typeof first?.code === "string" ? { code: first.code, ...(typeof first.value === "string" ? { value: first.value } : {}) } : null;
}

interface PromoDialogProps {
  listing: OwnerListingSummary & { catalogue: OwnerCatalogue };
  title: string;
  now: Date;
  onClose: () => void;
  onChanged: (listing: OwnerListingSummary) => void;
}

function PromoDialog({ listing, title, now, onClose, onChanged }: PromoDialogProps) {
  const t = useTranslations("MyListings.promo");
  const locale = useLocale() as Locale;
  const apiMessage = useApiErrorMessage();
  const names = useVariantLabels();
  const dateTime = useDateTime();
  const descriptionId = useId();
  const { catalogue } = listing;
  const variants = catalogue.variants;
  const from = Math.max(now.getTime(), new Date(catalogue.promoFrom).getTime());
  const waits = from > now.getTime() + 60_000;

  const [kind, setKind] = useState<PromoKind>("promo");
  const [mode, setMode] = useState<"percent" | "price">("percent");
  const [percentText, setPercentText] = useState("20");
  const [priceText, setPriceText] = useState("");
  const [startsLater, setStartsLater] = useState(waits);
  const [startText, setStartText] = useState(() => localInput(from));
  const [endText, setEndText] = useState(() => localInput(from + 7 * DAY_MS));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const percent = Math.min(parsePriceInput(percentText) ?? 0, PROMO_PERCENT_MAX);
  const fixed = parsePriceInput(priceText);
  const effectiveMode = variants ? "percent" : mode;

  const rows = (variants ? variants.items.map((item) => ({ key: item.key, name: names.combination(variants.axes, item.key), before: item.price ?? listing.price })) : [{ key: "", name: null, before: listing.price }]).map(
    (row) => {
      const before = row.before ?? 0;
      const price = effectiveMode === "percent" ? (percent > 0 ? promoPriceOf(before, percent) : null) : fixed;
      return { ...row, before, price, reference: catalogue.references[row.key] ?? null };
    },
  );
  const deepest = Math.max(0, ...rows.map((row) => (row.price === null ? 0 : percentOff(row.price, row.reference ?? row.before))));
  const anyReference = rows.some((row) => row.reference !== null);

  function chooseKind(next: PromoKind) {
    setKind(next);
    // A flash sale lasts 72 hours at most: its default end is a day after the start.
    const start = startsLater ? (parseLocalInput(startText) ?? from) : now.getTime();
    const end = parseLocalInput(endText);
    if (next === "flash" && (end === null || end - start > FLASH_MAX_MS)) setEndText(localInput(start + DAY_MS));
  }

  function issueMessage(issue: { code: string; value?: string }): string {
    const key = `errors.${issue.code}` as Parameters<typeof t.has>[0];
    if (!t.has(key)) return t("errors.promo_no_price");
    const value = issue.value === undefined ? "" : issue.code === "promo_gap" ? dateTime(issue.value) : formatPrice(Number(issue.value), locale);
    return t(key, { value });
  }

  async function save() {
    setError(null);
    const startsAt = startsLater ? parseLocalInput(startText) : null;
    const endsAt = parseLocalInput(endText);
    if (endsAt === null || (startsLater && startsAt === null)) return setError(t("errors.promo_end_before_start"));
    const input: PromoInput = {
      kind,
      endsAt: new Date(endsAt).toISOString(),
      ...(startsAt !== null ? { startsAt: new Date(startsAt).toISOString() } : {}),
      ...(effectiveMode === "percent" ? { percent } : { price: fixed ?? 0 }),
    };
    setSaving(true);
    try {
      const response = await savePromo(listing.id, input);
      toast.success(response.listing.status === "pending_review" ? t("savedHeld") : t("saved"));
      onChanged(response.listing);
      onClose();
    } catch (failure) {
      const issue = promoIssue(failure);
      setError(issue ? issueMessage(issue) : apiMessage(failure));
    } finally {
      setSaving(false);
    }
  }

  async function stop() {
    setSaving(true);
    try {
      const response = await endPromo(listing.id);
      toast.success(t("stopped"));
      onChanged(response.listing);
      onClose();
    } catch (failure) {
      toast.error(apiMessage(failure));
    } finally {
      setSaving(false);
    }
  }

  const current = catalogue.promo;

  return (
    <Dialog.Root open onOpenChange={(value) => !value && !saving && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={descriptionId}
          data-testid="promo-dialog"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-lg border border-border bg-surface shadow-xl shadow-bab-950/20 outline-none",
            "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:max-h-[88dvh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg rtl:sm:translate-x-1/2",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <div className="flex flex-col gap-1.5 border-b border-border px-5 pt-5 pb-4 sm:px-6">
            <Dialog.Title className="text-lg font-semibold text-balance">{t("title", { title: isolate(title) })}</Dialog.Title>
            <Dialog.Description id={descriptionId} className="text-sm text-foreground-muted text-pretty">
              {t("hint", { site: SITE_NAME })}
            </Dialog.Description>
          </div>

          {current ? (
            <div className="flex flex-col gap-3 px-5 py-4 sm:px-6">
              <p className="text-base font-medium text-pretty">
                {promoRunning(current, now.getTime())
                  ? t("running", { kind: t(`kinds.${current.kind}`), end: dateTime(current.endsAt) })
                  : t("scheduled", { kind: t(`kinds.${current.kind}`), start: dateTime(current.startsAt), end: dateTime(current.endsAt) })}
              </p>
              <PreviewTable rows={current.prices.map((entry) => ({ key: entry.key, name: variants && entry.key ? names.combination(variants.axes, entry.key) : null, before: null, price: entry.price, reference: entry.reference }))} locale={locale} />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4 sm:px-6">
              {waits ? (
                <p className="flex items-start gap-2 rounded-md bg-warning-surface px-3 py-2 text-sm text-pretty">
                  <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                  {t("gap", { date: dateTime(from) })}
                </p>
              ) : null}

              <div className="flex flex-col gap-2">
                <ChipRadioGroup label={t("kind")} options={PROMO_KINDS.map((value) => ({ value, label: t(`kinds.${value}`) }))} value={kind} onChange={(value) => chooseKind(value as PromoKind)} />
                <p className="text-sm text-foreground-muted text-pretty">{t(`kindHints.${kind}`)}</p>
              </div>

              {variants ? null : (
                <ChipRadioGroup
                  label={t("mode")}
                  options={[
                    { value: "percent", label: t("modes.percent") },
                    { value: "price", label: t("modes.price") },
                  ]}
                  value={mode}
                  onChange={(value) => setMode(value as "percent" | "price")}
                />
              )}

              {effectiveMode === "percent" ? (
                <Field label={t("percent")}>
                  <Input type="text" inputMode="numeric" dir="ltr" autoComplete="off" className="w-28 text-end tabular-nums" value={percentText} onChange={(event) => setPercentText(event.target.value.replace(/\D/g, "").slice(0, 2))} />
                </Field>
              ) : (
                <Field label={t("price")}>
                  <Input type="text" inputMode="numeric" dir="ltr" autoComplete="off" className="w-36 text-end tabular-nums" value={priceText} onChange={(event) => setPriceText(event.target.value)} />
                </Field>
              )}

              <div className="flex flex-col gap-3">
                <ChipRadioGroup
                  label={t("start")}
                  options={[
                    { value: "now", label: t("startNow") },
                    { value: "later", label: t("startAt") },
                  ]}
                  value={startsLater ? "later" : "now"}
                  onChange={(value) => setStartsLater(value === "later")}
                />
                {startsLater ? (
                  <Field label={t("startAtLabel")}>
                    <Input type="datetime-local" dir="ltr" className="w-full sm:w-64" min={localInput(from)} max={localInput(now.getTime() + 30 * DAY_MS)} value={startText} onChange={(event) => setStartText(event.target.value)} />
                  </Field>
                ) : null}
                <Field label={t("endsAt")}>
                  <Input
                    type="datetime-local"
                    dir="ltr"
                    className="w-full sm:w-64"
                    min={localInput((startsLater ? (parseLocalInput(startText) ?? from) : now.getTime()) + 60 * 60 * 1000)}
                    max={localInput((startsLater ? (parseLocalInput(startText) ?? from) : now.getTime()) + (kind === "flash" ? FLASH_MAX_MS : PROMO_MAX_MS))}
                    value={endText}
                    onChange={(event) => setEndText(event.target.value)}
                  />
                </Field>
              </div>

              <section aria-label={t("preview")} className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">{t("preview")}</h3>
                <PreviewTable rows={rows} locale={locale} />
                {anyReference ? null : <p className="text-sm text-foreground-muted text-pretty">{t("noReference")}</p>}
                {deepest > PROMO_REVIEW_PERCENT ? (
                  <p className="flex items-start gap-2 rounded-md bg-surface-muted px-3 py-2 text-sm text-pretty">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground-muted" aria-hidden="true" />
                    {t("review", { percent: PROMO_REVIEW_PERCENT })}
                  </p>
                ) : null}
              </section>

              {error ? (
                <p role="alert" data-testid="promo-error" className="rounded-md bg-danger-surface px-3 py-2 text-sm text-danger text-pretty">
                  {error}
                </p>
              ) : null}
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
            <Dialog.Close asChild>
              <Button type="button" variant="outline" disabled={saving}>
                {current ? t("close") : t("cancel")}
              </Button>
            </Dialog.Close>
            {current ? (
              <Button type="button" variant="danger" loading={saving} onClick={() => void stop()}>
                {t("stop")}
              </Button>
            ) : (
              <Button type="button" loading={saving} disabled={effectiveMode === "percent" ? percent < 1 : fixed === null} onClick={() => void save()}>
                {t("save")}
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface PreviewRow {
  key: string;
  name: string | null;
  /** The current price (null: not shown, a running promotion). */
  before: number | null;
  price: number | null;
  reference: number | null;
}

function PreviewTable({ rows, locale }: { rows: PreviewRow[]; locale: Locale }) {
  const t = useTranslations("MyListings.promo");
  const showBefore = rows.some((row) => row.before !== null);
  return (
    <table data-testid="promo-preview" className="w-full text-sm tabular-nums">
      <thead className="text-xs text-foreground-muted">
        <tr>
          {rows.some((row) => row.name) ? <th scope="col" className="py-1 text-start font-medium" /> : null}
          {showBefore ? (
            <th scope="col" className="py-1 text-end font-medium">
              {t("current")}
            </th>
          ) : null}
          <th scope="col" className="py-1 text-end font-medium">
            {t("reference")}
          </th>
          <th scope="col" className="py-1 text-end font-medium">
            {t("newPrice")}
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((row) => {
          const wrong = row.price !== null && ((row.before !== null && row.price >= row.before) || (row.reference !== null && row.price >= row.reference));
          return (
            <tr key={row.key}>
              {row.name ? (
                <th scope="row" className="py-1.5 text-start font-medium">
                  {row.name}
                </th>
              ) : rows.some((entry) => entry.name) ? (
                <td />
              ) : null}
              {showBefore ? <td className="py-1.5 text-end">{row.before !== null ? formatPrice(row.before, locale) : ""}</td> : null}
              <td className="py-1.5 text-end text-foreground-muted">{row.reference !== null ? <s className="decoration-1">{formatPrice(row.reference, locale)}</s> : "—"}</td>
              <td className={cn("py-1.5 text-end font-semibold", wrong ? "text-warning" : "text-danger")}>{row.price !== null ? formatPrice(row.price, locale) : "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
