"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { Camera, CircleCheck, Send, Tag } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormMessage } from "@/components/auth/form-message";
import { TurnstileWidget, type TurnstileHandle } from "@/components/auth/turnstile-widget";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { textLinkClassName } from "@/components/ui/text-link";
import { subcategoryById } from "@/config/categories";
import { SITE_NAME } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { isApiError } from "@/lib/auth/client";
import type { ListingStatus } from "@/lib/contracts/listings";
import { MAX_PHOTOS_PRO } from "@/lib/contracts/media";
import type { StockListing } from "@/lib/contracts/stock-import";
import { getListing, listingAction, patchListing, publishListing } from "@/lib/listings/client/api";
import { ACCEPTED_INPUT_TYPES } from "@/lib/listings/client/prepare-image";
import { uploadListingPhoto } from "@/lib/listings/client/upload";
import { needsRealEstateAttestation } from "@/lib/listings/real-estate";
import { matchPhotos } from "@/lib/pro/stock-import/photos";
import { cn } from "@/lib/utils";
import { FileDrop, Step } from "./stock-ui";

// Steps 3 to 5 of the stock import (design concession/concession.md §4): photos by file name
// through the usual upload pipeline, the publication of the complete drafts one by one (Turnstile
// when the IP escalates, the Pro limits), and the references the last file no longer lists.

/** Listings that take new photos (uploads policy PHOTO_TARGET_STATUSES). */
const PHOTO_TARGETS: readonly ListingStatus[] = ["draft", "pending_review", "published", "paused", "expired", "rejected"];
/** The pipeline attaches a ready photo itself to these; the others need the owner's save. */
const AUTO_ATTACH: readonly ListingStatus[] = ["draft", "rejected"];
/** Errors that stop a whole run (the next listings would fail the same way). */
const STOPPING = ["rate_limited", "quota_exhausted", "storage_full", "listing_daily_limit", "listing_limit", "unauthenticated", "unavailable"] as const;

interface Progress {
  done: number;
  total: number;
}

export function PhotosStep({ stock, onDone }: { stock: readonly StockListing[]; onDone: () => Promise<void> }) {
  const t = useTranslations("StockImport.photos");
  const targets = useMemo(() => stock.filter((listing) => PHOTO_TARGETS.includes(listing.status)), [stock]);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [outcome, setOutcome] = useState<{ sent: number; refused: number; failed: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const match = useMemo(() => matchPhotos(files, targets), [files, targets]);
  const byId = useMemo(() => new Map(targets.map((listing) => [listing.id, listing])), [targets]);
  // Room left on each listing (20 photos for a Pro): the extra files are left out.
  const planned = useMemo(() => [...match.byListing].map(([id, list]) => ({ listing: byId.get(id)!, files: list.slice(0, Math.max(0, MAX_PHOTOS_PRO - byId.get(id)!.photoCount)), extra: Math.max(0, list.length - Math.max(0, MAX_PHOTOS_PRO - byId.get(id)!.photoCount)) })), [match, byId]);
  const total = planned.reduce((sum, item) => sum + item.files.length, 0);

  async function run() {
    setError(null);
    setOutcome(null);
    let done = 0;
    const tally = { sent: 0, refused: 0, failed: 0 };
    setProgress({ done, total });
    try {
      for (const { listing, files: list } of planned) {
        const fresh: string[] = [];
        for (const file of list) {
          try {
            const result = await uploadListingPhoto(listing.id, file);
            if (result.status.status === "ready") {
              fresh.push(result.uploadId);
              tally.sent += 1;
            } else if (result.status.status === "rejected") tally.refused += 1;
            else fresh.push(result.uploadId);
          } catch (caught) {
            if (isApiError(caught, ...STOPPING)) throw caught;
            tally.failed += 1;
          }
          done += 1;
          setProgress({ done, total });
        }
        // A live listing takes its new photos with a save, screened again like a hand edit.
        if (fresh.length > 0 && !AUTO_ATTACH.includes(listing.status)) {
          const current = (await getListing(listing.id)).listing.photos.filter((photo) => photo.status === "ready").map((photo) => photo.id);
          await patchListing(listing.id, { photos: [...current, ...fresh.filter((id) => !current.includes(id))] });
        }
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setOutcome(tally);
      setProgress(null);
      setFiles([]);
      await onDone();
    }
  }

  return (
    <Step index={3} title={t("title")} lead={t("lead")} muted={targets.length === 0}>
      {targets.length === 0 ? (
        <p className="text-sm text-foreground-muted">{t("empty")}</p>
      ) : (
        <>
          <FileDrop accept={ACCEPTED_INPUT_TYPES} multiple label={t("pick")} hint={t("hint")} icon={<Camera aria-hidden="true" className="size-6" />} onFiles={(picked) => setFiles((current) => [...current, ...picked])} busy={progress !== null} />
          {files.length > 0 ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4" data-testid="stock-photos">
              <p className="text-sm font-medium">{t("matched", { photos: total, listings: planned.length })}</p>
              <ul className="flex flex-col gap-1 text-sm">
                {planned.map(({ listing, files: list, extra }) => (
                  <li key={listing.id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium" dir="ltr">
                      {listing.ref}
                    </span>
                    <span className="text-foreground-muted">{t("count", { count: list.length })}</span>
                    {extra > 0 ? <span className="text-warning">{t("extra", { count: extra, max: MAX_PHOTOS_PRO })}</span> : null}
                  </li>
                ))}
              </ul>
              {match.unmatched.length > 0 ? <p className="text-sm text-warning">{t("unmatched", { count: match.unmatched.length, names: match.unmatched.slice(0, 5).map((file) => file.name).join(", ") })}</p> : null}
              <div className="flex flex-wrap gap-3">
                <Button disabled={total === 0} loading={progress !== null} onClick={() => void run()}>
                  {t("send", { count: total })}
                </Button>
                <Button variant="ghost" disabled={progress !== null} onClick={() => setFiles([])}>
                  {t("clear")}
                </Button>
              </div>
            </div>
          ) : null}
          <p role="status" className="text-sm">
            {progress ? t("progress", { done: progress.done, total: progress.total }) : outcome ? t("outcome", outcome) : null}
          </p>
          <FormMessage error={error ?? undefined} scope="listing" />
        </>
      )}
    </Step>
  );
}

type PublishResult = "published" | "pending_review" | "incomplete" | "failed";

const legal = (slug: "cgu" | "objets-interdits") =>
  function LegalLink(chunks: ReactNode) {
    return (
      <Link href={`/legal/${slug}`} target="_blank" rel="noopener" className={cn("font-medium text-link", textLinkClassName)}>
        {chunks}
      </Link>
    );
  };

export function PublishStep({ stock, nonce, onDone }: { stock: readonly StockListing[]; nonce?: string; onDone: () => Promise<void> }) {
  const t = useTranslations("StockImport.publish");
  const drafts = useMemo(() => stock.filter((listing) => listing.status === "draft"), [stock]);
  const ready = drafts.filter((listing) => listing.photoCount > 0);
  const [accepted, setAccepted] = useState(false);
  // Real estate in the batch: the agency attests the declared data of those listings (review-step).
  const realEstate = ready.some((listing) => needsRealEstateAttestation(subcategoryById(listing.subcategoryId ?? "")));
  const [declared, setDeclared] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [results, setResults] = useState<Map<string, PublishResult>>(new Map());
  const [error, setError] = useState<unknown>(null);
  const [needToken, setNeedToken] = useState(false);
  const turnstile = useRef<TurnstileHandle>(null);
  const queue = useRef<StockListing[]>([]);

  async function run(token?: string) {
    setError(null);
    const outcome = new Map(results);
    const total = queue.current.length + outcome.size;
    let pass = token;
    let paused = false;
    try {
      while (queue.current.length > 0) {
        const listing = queue.current[0]!;
        setProgress({ done: outcome.size, total });
        try {
          const attest = needsRealEstateAttestation(subcategoryById(listing.subcategoryId ?? ""));
          const response = await publishListing(listing.id, { acceptRules: true, ...(attest ? { realEstateAttestation: true } : {}), ...(pass ? { turnstileToken: pass } : {}) });
          outcome.set(listing.id, response.status === "published" ? "published" : "pending_review");
        } catch (caught) {
          if (isApiError(caught, "turnstile_required", "turnstile_failed")) {
            // Solved once, the pass cookie covers the following publications.
            paused = true;
            setNeedToken(true);
            turnstile.current?.reset();
            return;
          }
          if (isApiError(caught, ...STOPPING)) throw caught;
          outcome.set(listing.id, isApiError(caught, "invalid_listing") ? "incomplete" : "failed");
        } finally {
          pass = undefined;
        }
        queue.current.shift();
        setResults(new Map(outcome));
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setResults(new Map(outcome));
      setProgress(null);
      if (!paused) await onDone();
    }
  }

  function start() {
    queue.current = [...ready];
    setResults(new Map());
    setNeedToken(false);
    void run();
  }

  function onToken(token: string | null) {
    if (!token) return;
    setNeedToken(false);
    void run(token);
  }

  const counts = { published: 0, pending_review: 0, incomplete: 0, failed: 0 };
  for (const value of results.values()) counts[value] += 1;
  const titles = new Map(stock.map((listing) => [listing.id, listing]));
  const incomplete = [...results].filter(([, value]) => value === "incomplete").map(([id]) => titles.get(id)).filter((listing): listing is StockListing => listing !== undefined);

  return (
    <Step index={4} title={t("title")} lead={t("lead")} muted={drafts.length === 0 && results.size === 0}>
      {drafts.length === 0 && results.size === 0 ? (
        <p className="text-sm text-foreground-muted">{t("empty")}</p>
      ) : (
        <>
          <p className="text-sm">{t("drafts", { ready: ready.length, missing: drafts.length - ready.length })}</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} className="mt-0.5 size-4 shrink-0 accent-structure" />
            <span className="text-pretty">{t.rich("rules", { cgu: legal("cgu"), interdits: legal("objets-interdits") })}</span>
          </label>
          {realEstate ? (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={declared} onChange={(event) => setDeclared(event.target.checked)} className="mt-0.5 size-4 shrink-0 accent-structure" />
              <span className="text-pretty">{t("realEstate", { brand: SITE_NAME })}</span>
            </label>
          ) : null}
          <div className="flex flex-wrap gap-3">
            <Button disabled={!accepted || (realEstate && !declared) || ready.length === 0 || progress !== null || needToken} loading={progress !== null} onClick={start}>
              <Send aria-hidden="true" />
              {t("send", { count: ready.length })}
            </Button>
          </div>
          {needToken ? <TurnstileWidget ref={turnstile} action="listing" nonce={nonce} onToken={onToken} /> : null}
          <p role="status" className="text-sm">
            {progress ? t("progress", { done: progress.done, total: progress.total }) : results.size > 0 ? t("outcome", counts) : null}
          </p>
          {incomplete.length > 0 ? (
            <ErrorBanner tone="warning" title={t("incomplete", { count: incomplete.length })}>
              <ul className="mt-1 flex flex-col gap-1">
                {incomplete.map((listing) => (
                  <li key={listing.id}>
                    <Link href={`/deposer/${listing.id}/apercu`} className={cn("text-link", textLinkClassName)}>
                      <span dir="ltr">{listing.ref}</span> {listing.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </ErrorBanner>
          ) : null}
          <FormMessage error={error ?? undefined} scope="listing" />
        </>
      )}
    </Step>
  );
}

export function AbsentStep({ absent, onDone }: { absent: readonly StockListing[]; onDone: () => Promise<void> }) {
  const t = useTranslations("StockImport.absent");
  const [sold, setSold] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const left = absent.filter((listing) => !sold.has(listing.id));

  async function markSold(ids: readonly string[]) {
    setError(null);
    try {
      for (const id of ids) {
        setBusy(id);
        await listingAction(id, "sold");
        setSold((current) => new Set(current).add(id));
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
      await onDone();
    }
  }

  return (
    <Step index={5} title={t("title")} lead={t("lead")} muted={absent.length === 0}>
      {absent.length === 0 ? (
        <p className="text-sm text-foreground-muted">{t("empty")}</p>
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface" data-testid="stock-absent">
            {absent.map((listing) => (
              <li key={listing.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium" dir="ltr">
                    {listing.ref}
                  </span>
                  <span className="truncate text-sm text-foreground-muted">{listing.title}</span>
                </span>
                {sold.has(listing.id) ? (
                  <Badge variant="success">
                    <CircleCheck aria-hidden="true" className="size-3.5" />
                    {t("done")}
                  </Badge>
                ) : (
                  <Button size="sm" variant="outline" loading={busy === listing.id} disabled={busy !== null} onClick={() => void markSold([listing.id])}>
                    <Tag aria-hidden="true" />
                    {t("markOne")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {left.length > 1 ? (
            <Button variant="outline" className="w-fit" disabled={busy !== null} onClick={() => void markSold(left.map((listing) => listing.id))}>
              {t("markAll", { count: left.length })}
            </Button>
          ) : null}
          <FormMessage error={error ?? undefined} scope="listing" />
        </>
      )}
    </Step>
  );
}
