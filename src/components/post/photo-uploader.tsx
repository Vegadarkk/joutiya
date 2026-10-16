"use client";

import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Camera, ChevronLeft, ChevronRight, ImagePlus, RefreshCw, RotateCcw, Star, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { blurhashDataUrl } from "@/lib/listings/client/blurhash";
import { ACCEPTED_INPUT_TYPES } from "@/lib/listings/client/prepare-image";
import { isPhotoBusy, type PhotoItem } from "@/lib/listings/client/store";
import { cn } from "@/lib/utils";

// Step 5: tiles with progress, retry, remove, drag or arrow reorder (first = cover), rejected
// state with its reason. The file input accepts camera capture on phones (OS camera app: no
// getUserMedia, which Permissions-Policy denies).

interface PhotoUploaderProps {
  photos: PhotoItem[];
  maxPhotos: number;
  onAdd: (files: Iterable<File>) => void;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
  onRefresh: (key: string) => void;
  onMove: (key: string, to: number) => void;
}

export function PhotoUploader({ photos, maxPhotos, onAdd, onRemove, onRetry, onRefresh, onMove }: PhotoUploaderProps) {
  const t = useTranslations("Listing.photos");
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const room = Math.max(0, maxPhotos - photos.length);

  function onDrop(event: DragEvent, targetKey: string) {
    event.preventDefault();
    if (dragging && dragging !== targetKey) {
      const to = photos.findIndex((item) => item.key === targetKey);
      if (to !== -1) onMove(dragging, to);
    }
    setDragging(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-foreground-muted">
        <span className="tabular-nums">{t("count", { count: photos.length, max: maxPhotos })}</span>
        <span>{room > 0 ? t("tooMany", { count: room }) : t("full")}</span>
      </div>

      <ul aria-label={t("list")} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {photos.map((item, index) => (
          <li
            key={item.key}
            draggable={item.status === "ready"}
            onDragStart={() => setDragging(item.key)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onDrop(event, item.key)}
            className={cn("relative", dragging === item.key && "opacity-50")}
          >
            <PhotoTile item={item} index={index} total={photos.length} onRemove={onRemove} onRetry={onRetry} onRefresh={onRefresh} onMove={onMove} />
          </li>
        ))}
        {room > 0 ? (
          <li className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => picker.current?.click()}
              className={cn(
                "flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border-strong bg-surface-muted/60 text-foreground-muted",
                "transition-colors duration-150 ease-door hover:border-structure hover:text-structure focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25",
              )}
            >
              <ImagePlus className="size-7" aria-hidden="true" strokeWidth={1.75} />
              <span className="text-sm font-medium">{photos.length === 0 ? t("add") : t("addMore")}</span>
            </button>
            <button type="button" onClick={() => camera.current?.click()} className="flex min-h-11 items-center justify-center gap-2 rounded-md text-sm font-medium text-link hover:underline md:hidden">
              <Camera className="size-4" aria-hidden="true" />
              {t("camera")}
            </button>
          </li>
        ) : null}
      </ul>
      <input
        ref={picker}
        type="file"
        accept={ACCEPTED_INPUT_TYPES}
        multiple
        className="sr-only"
        aria-label={t("add")}
        tabIndex={-1}
        onChange={(event) => {
          if (event.target.files) onAdd(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        aria-label={t("camera")}
        tabIndex={-1}
        onChange={(event) => {
          if (event.target.files) onAdd(event.target.files);
          event.target.value = "";
        }}
      />

      {photos.length === 0 ? <ErrorBanner tone="info" title={t("noPhotoWarning")} /> : <p className="text-sm text-foreground-muted">{t("reorderHelp")}</p>}
    </div>
  );
}

interface PhotoTileProps {
  item: PhotoItem;
  index: number;
  total: number;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
  onRefresh: (key: string) => void;
  onMove: (key: string, to: number) => void;
}

function PhotoTile({ item, index, total, onRemove, onRetry, onRefresh, onMove }: PhotoTileProps) {
  const t = useTranslations("Listing.photos");
  const errors = useTranslations("Listing.errors");
  const n = index + 1;
  const busy = isPhotoBusy(item);
  const placeholder = blurhashDataUrl(item.blurhash);
  const failureMessage =
    item.status === "rejected"
      ? t(`rejectReasons.${item.rejectReason ?? "decode_failed"}`)
      : item.status === "failed"
        ? item.errorCode === "decode_failed"
          ? t("decodeFailed")
          : item.errorCode && errors.has(item.errorCode as Parameters<typeof errors.has>[0])
            ? errors(item.errorCode as Parameters<typeof errors.has>[0])
            : t("failed")
        : item.status === "timeout"
          ? t("timeout")
          : null;


  return (
    <figure className={cn("group relative overflow-hidden rounded-lg border bg-surface-muted", failureMessage ? "border-danger/50" : "border-border")}>
      <div className="relative aspect-[4/3] w-full">
        {placeholder && !item.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={placeholder} alt="" aria-hidden="true" className="absolute inset-0 size-full object-cover" />
        ) : null}
        {item.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.previewUrl} alt={t("photoAlt", { index: n })} className={cn("absolute inset-0 size-full object-cover", busy && "opacity-70")} decoding="async" />
        ) : (
          <span className="sr-only">{t("photoAlt", { index: n })}</span>
        )}
        {index === 0 && item.status === "ready" ? (
          <Badge variant="featured" className="absolute start-2 top-2 gap-1">
            <Star className="size-3" aria-hidden="true" />
            {t("cover")}
          </Badge>
        ) : null}
        {busy ? (
          <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-bab-950/60 px-3 py-2 text-xs text-cream-100">
            <span className="flex items-center gap-1.5">
              <Spinner className="size-3.5" />
              {item.status === "preparing" ? t("preparing") : item.status === "uploading" ? t("uploading", { percent: Math.round(item.progress * 100) }) : t("processing")}
            </span>
            <span className="h-1 w-full overflow-hidden rounded-full bg-cream-100/30" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress * 100)} aria-label={t("photoAlt", { index: n })}>
              <span className="block h-full rounded-full bg-featured transition-[width] duration-150" style={{ width: `${Math.round(item.progress * 100)}%` }} />
            </span>
          </div>
        ) : null}
        {!busy ? (
          <button
            type="button"
            onClick={() => onRemove(item.key)}
            aria-label={t("remove", { index: n })}
            className="absolute end-2 top-2 flex size-9 items-center justify-center rounded-full bg-surface/90 text-foreground shadow-sm transition-colors duration-150 hover:bg-surface focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <figcaption className="flex min-h-11 items-center justify-between gap-1 px-1.5 py-1">
        {failureMessage ? (
          <span role="alert" className="flex-1 truncate ps-1 text-xs text-danger" title={failureMessage}>
            {failureMessage}
          </span>
        ) : (
          <span className="flex items-center gap-0.5">
            <TileButton label={t("moveBack", { index: n })} disabled={index === 0 || item.status !== "ready"} onClick={() => onMove(item.key, index - 1)}>
              <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden="true" />
            </TileButton>
            <TileButton label={t("moveForward", { index: n })} disabled={index >= total - 1 || item.status !== "ready"} onClick={() => onMove(item.key, index + 1)}>
              <ChevronRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
            </TileButton>
            {index > 0 && item.status === "ready" ? (
              <TileButton label={t("setCover")} onClick={() => onMove(item.key, 0)}>
                <Star className="size-4" aria-hidden="true" />
              </TileButton>
            ) : null}
          </span>
        )}
        {item.status === "failed" || item.status === "rejected" ? (
          item.file ? (
            <TileButton label={t("retry", { index: n })} onClick={() => onRetry(item.key)}>
              <RotateCcw className="size-4" aria-hidden="true" />
            </TileButton>
          ) : null
        ) : item.status === "timeout" ? (
          <TileButton label={t("refresh", { index: n })} onClick={() => onRefresh(item.key)}>
            <RefreshCw className="size-4" aria-hidden="true" />
          </TileButton>
        ) : null}
      </figcaption>
    </figure>
  );
}

function TileButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-9 items-center justify-center rounded-md text-foreground-muted transition-colors duration-150 hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25 disabled:opacity-30"
    >
      {children}
    </button>
  );
}
