"use client";

import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Camera, ChevronLeft, ChevronRight, ImagePlus, RefreshCw, RotateCcw, Star, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useNumbersTranslations } from "@/i18n/numbers";
import { blurhashDataUrl } from "@/lib/listings/client/blurhash";
import { ACCEPTED_INPUT_TYPES } from "@/lib/listings/client/prepare-image";
import { isPhotoBusy, usedSlots, type PhotoItem } from "@/lib/listings/client/store";
import { cn } from "@/lib/utils";

// Step 5: tiles with progress, cancel, retry, remove, drag or button reorder (first = cover),
// rejected state with its reason; files can also be dropped on the add tile. The file input
// accepts camera capture on phones (OS camera app: no getUserMedia, which Permissions-Policy
// denies). Moves are announced to screen readers and keep the focus on the moved photo.

interface PhotoUploaderProps {
  photos: PhotoItem[];
  maxPhotos: number;
  onAdd: (files: Iterable<File>) => void;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
  onRefresh: (key: string) => void;
  onMove: (key: string, to: number) => void;
  /** A live listing keeps at least one photo (the API refuses to remove the last one). */
  keepOne?: boolean;
}

type FocusTarget = { key: string; action: "back" | "forward" | "cover" };

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

export function PhotoUploader({ photos, maxPhotos, onAdd, onRemove, onRetry, onRefresh, onMove, keepOne = false }: PhotoUploaderProps) {
  const t = useNumbersTranslations("Listing.photos");
  const errors = useTranslations("Listing.errors");
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [fileOver, setFileOver] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const focusAfterMove = useRef<FocusTarget | null>(null);
  // Failed and refused tiles take no slot: the counter and the room leave them out.
  const used = usedSlots(photos);
  const room = Math.max(0, maxPhotos - used);
  const readyCount = photos.filter((item) => item.status === "ready").length;
  // The upload cap counts refused photos too: the tile says it briefly, the banner what to do.
  const uploadLimited = photos.some((item) => item.status === "failed" && item.errorCode === "upload_limit");

  // The moved tile changed place in the DOM: give the focus back to the control that moved it.
  useEffect(() => {
    const target = focusAfterMove.current;
    if (!target || !list.current) return;
    focusAfterMove.current = null;
    const tile = list.current.querySelector<HTMLElement>(`[data-photo-key="${CSS.escape(target.key)}"]`);
    const order = target.action === "back" ? ["back", "forward"] : target.action === "forward" ? ["forward", "back"] : ["back", "forward"];
    for (const action of order) {
      const button = tile?.querySelector<HTMLButtonElement>(`[data-action="${action}"]:not(:disabled)`);
      if (button) {
        button.focus();
        return;
      }
    }
  }, [photos]);

  function move(key: string, to: number, action: FocusTarget["action"]) {
    const bounded = Math.max(0, Math.min(photos.length - 1, to));
    focusAfterMove.current = { key, action };
    onMove(key, bounded);
    setAnnouncement(bounded === 0 ? t("movedCover") : t("moved", { position: bounded + 1, count: photos.length }));
  }

  function onDrop(event: DragEvent, targetKey: string) {
    event.preventDefault();
    if (dragging && dragging !== targetKey) {
      const to = photos.findIndex((item) => item.key === targetKey);
      if (to !== -1) {
        onMove(dragging, to);
        setAnnouncement(to === 0 ? t("movedCover") : t("moved", { position: to + 1, count: photos.length }));
      }
    }
    setDragging(null);
    setOver(null);
  }

  function addFrom(input: HTMLInputElement) {
    if (input.files && input.files.length > 0) onAdd(input.files);
    input.value = "";
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-foreground-muted">
        <span className="font-medium tabular-nums text-foreground">{t("count", { count: used, max: maxPhotos })}</span>
        <span>{room > 0 ? t("tooMany", { count: room }) : t("full")}</span>
      </div>
      {uploadLimited ? <ErrorBanner tone="warning" title={errors("upload_limit")} /> : null}

      <ul ref={list} aria-label={t("list")} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {photos.map((item, index) => (
          <li
            key={item.key}
            data-photo-key={item.key}
            draggable={item.status === "ready" && !item.removing}
            onDragStart={(event) => {
              setDragging(item.key);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              setDragging(null);
              setOver(null);
            }}
            onDragOver={(event) => {
              if (!dragging) return;
              event.preventDefault();
              if (over !== item.key) setOver(item.key);
            }}
            onDragLeave={() => setOver((current) => (current === item.key ? null : current))}
            onDrop={(event) => onDrop(event, item.key)}
            className={cn(
              "relative rounded-lg transition-[opacity,scale,box-shadow] duration-150 ease-door",
              dragging === item.key && "scale-[0.97] opacity-50",
              over === item.key && dragging !== item.key && "ring-3 ring-featured ring-offset-2 ring-offset-background",
              item.status === "ready" && !item.removing && "cursor-grab active:cursor-grabbing",
            )}
          >
            <PhotoTile
              item={item}
              index={index}
              total={photos.length}
              canRemove={!(keepOne && item.status === "ready" && readyCount <= 1)}
              canRetry={room > 0}
              onRemove={onRemove}
              onRetry={onRetry}
              onRefresh={onRefresh}
              onMove={move}
            />
          </li>
        ))}
        {room > 0 ? (
          <li className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => picker.current?.click()}
              onDragOver={(event) => {
                if (!hasFiles(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
                setFileOver(true);
              }}
              onDragLeave={() => setFileOver(false)}
              onDrop={(event) => {
                if (!hasFiles(event)) return;
                event.preventDefault();
                setFileOver(false);
                onAdd(event.dataTransfer.files);
              }}
              className={cn(
                "group flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border-strong bg-surface-muted/60 px-3 text-center text-foreground-muted",
                "transition-[border-color,background-color,color] duration-150 ease-door hover:border-structure hover:text-structure",
                fileOver && "border-structure bg-surface-brand text-structure",
              )}
            >
              <ImagePlus className="size-7 transition-transform duration-150 ease-door group-hover:-translate-y-0.5" aria-hidden="true" strokeWidth={1.75} />
              <span className="text-sm font-medium">{photos.length === 0 ? t("add") : t("addMore")}</span>
              <span className="hidden text-xs md:block">{t("dropHint")}</span>
            </button>
            <button type="button" onClick={() => camera.current?.click()} className="flex min-h-11 items-center justify-center gap-2 rounded-md text-sm font-medium text-link hover:underline md:hidden">
              <Camera className="size-4" aria-hidden="true" />
              {t("camera")}
            </button>
          </li>
        ) : null}
      </ul>
      <input ref={picker} type="file" accept={ACCEPTED_INPUT_TYPES} multiple className="sr-only" aria-label={t("add")} tabIndex={-1} onChange={(event) => addFrom(event.target)} />
      <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" aria-label={t("camera")} tabIndex={-1} onChange={(event) => addFrom(event.target)} />
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      {photos.length === 0 ? <ErrorBanner tone="info" title={t("noPhotoWarning")} /> : <p className="text-sm text-foreground-muted">{t("reorderHelp")}</p>}
    </div>
  );
}

interface PhotoTileProps {
  item: PhotoItem;
  index: number;
  total: number;
  canRemove: boolean;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
  /** A free slot exists: a failed or refused tile may start again. */
  canRetry: boolean;
  onRefresh: (key: string) => void;
  onMove: (key: string, to: number, action: FocusTarget["action"]) => void;
}

function PhotoTile({ item, index, total, canRemove, onRemove, onRetry, canRetry, onRefresh, onMove }: PhotoTileProps) {
  const t = useNumbersTranslations("Listing.photos");
  const errors = useTranslations("Listing.errors");
  const n = index + 1;
  const busy = isPhotoBusy(item);
  const ready = item.status === "ready" && !item.removing;
  const placeholder = blurhashDataUrl(item.blurhash);
  const percent = Math.round(item.progress * 100);
  const failureMessage =
    item.errorCode === "remove_failed"
      ? t("removeFailed")
      : item.errorCode === "photos_required"
        ? t("keepOne")
        : item.status === "rejected"
          ? t(`rejectReasons.${item.rejectReason ?? "decode_failed"}`)
          : item.status === "failed"
            ? item.errorCode === "decode_failed"
              ? t("decodeFailed")
              : item.errorCode === "upload_limit"
                ? t("uploadLimit")
                : item.errorCode && errors.has(item.errorCode as Parameters<typeof errors.has>[0])
                ? errors(item.errorCode as Parameters<typeof errors.has>[0])
                : t("failed")
            : item.status === "timeout"
              ? t("timeout")
              : null;

  return (
    <figure className={cn("relative overflow-hidden rounded-lg border bg-surface-muted", failureMessage ? "border-danger/50" : "border-border", item.removing && "opacity-60")}>
      <div className="relative aspect-[4/3] w-full">
        {placeholder && !item.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={placeholder} alt="" aria-hidden="true" className="absolute inset-0 size-full object-cover" />
        ) : null}
        {item.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.previewUrl} alt={t("photoAlt", { index: n })} draggable={false} className={cn("absolute inset-0 size-full object-cover transition-opacity duration-150", busy && "opacity-70")} decoding="async" />
        ) : (
          <span className="sr-only">{t("photoAlt", { index: n })}</span>
        )}
        {index === 0 && item.status === "ready" ? (
          <Badge variant="featured" className="absolute start-2 top-2 gap-1 shadow-sm">
            <Star className="size-3" aria-hidden="true" />
            {t("cover")}
          </Badge>
        ) : null}
        {busy || item.removing ? (
          <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-bab-950/65 px-3 py-2 text-xs text-cream-100">
            <span className="flex items-center gap-1.5">
              <Spinner className="size-3.5" />
              {item.removing ? t("removing") : item.status === "preparing" ? t("preparing") : item.status === "uploading" ? t("uploading", { percent }) : t("processing")}
            </span>
            {busy ? (
              <span
                className="h-1 w-full overflow-hidden rounded-full bg-cream-100/30"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={item.status === "uploading" ? percent : undefined}
                aria-label={t("progressLabel", { index: n })}
              >
                <span
                  className={cn("block h-full rounded-full bg-featured transition-[width] duration-150", item.status !== "uploading" && "animate-pulse")}
                  style={{ width: `${item.status === "preparing" ? 8 : item.status === "uploading" ? Math.max(8, percent) : 100}%` }}
                />
              </span>
            ) : null}
          </div>
        ) : null}
        {!item.removing ? (
          <button
            type="button"
            onClick={() => onRemove(item.key)}
            disabled={!canRemove}
            title={canRemove ? undefined : t("keepOne")}
            aria-label={busy ? t("cancel", { index: n }) : t("remove", { index: n })}
            className="absolute end-1 top-1 flex size-11 items-center justify-center rounded-full focus-visible:outline-none disabled:cursor-not-allowed [&:focus-visible>span]:outline-2 [&:focus-visible>span]:outline-offset-0 [&:focus-visible>span]:outline-ring"
          >
            <span className="flex size-8 items-center justify-center rounded-full bg-surface/90 text-foreground shadow-sm transition-colors duration-150 ease-door hover:bg-surface [button:disabled>&]:opacity-40">
              <X className="size-4" aria-hidden="true" />
            </span>
          </button>
        ) : null}
      </div>
      <figcaption className="flex min-h-11 items-center justify-between gap-1 px-1 py-0.5">
        {failureMessage ? (
          <span role="alert" className="line-clamp-2 flex-1 ps-1.5 text-xs leading-snug text-danger" title={failureMessage}>
            {failureMessage}
          </span>
        ) : (
          <span className="flex items-center">
            <TileButton action="back" label={t("moveBack", { index: n })} disabled={index === 0 || !ready} onClick={() => onMove(item.key, index - 1, "back")}>
              <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden="true" />
            </TileButton>
            <TileButton action="forward" label={t("moveForward", { index: n })} disabled={index >= total - 1 || !ready} onClick={() => onMove(item.key, index + 1, "forward")}>
              <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
            </TileButton>
            {index > 0 && ready ? (
              <TileButton action="cover" label={t("setCover")} onClick={() => onMove(item.key, 0, "cover")}>
                <Star className="size-4" aria-hidden="true" />
              </TileButton>
            ) : null}
          </span>
        )}
        {(item.status === "failed" || item.status === "rejected") && item.file && !item.errorCode?.startsWith("remove") ? (
          <TileButton label={t("retry", { index: n })} disabled={!canRetry} onClick={() => onRetry(item.key)}>
            <RotateCcw className="size-4" aria-hidden="true" />
          </TileButton>
        ) : item.status === "timeout" ? (
          <TileButton label={t("refresh", { index: n })} onClick={() => onRefresh(item.key)}>
            <RefreshCw className="size-4" aria-hidden="true" />
          </TileButton>
        ) : null}
      </figcaption>
    </figure>
  );
}

function TileButton({ label, disabled, onClick, children, action }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode; action?: FocusTarget["action"] }) {
  return (
    <button
      type="button"
      aria-label={label}
      data-action={action}
      disabled={disabled}
      onClick={onClick}
      className="flex size-11 shrink-0 items-center justify-center rounded-md text-foreground-muted transition-[background-color,color,scale] duration-150 ease-door hover:bg-surface hover:text-foreground active:scale-[0.98] disabled:opacity-30"
    >
      {children}
    </button>
  );
}
