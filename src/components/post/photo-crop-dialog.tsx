"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Dialog } from "radix-ui";
import { useTranslations } from "next-intl";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { INITIAL_CROP, cropPixels, moveRect, resizeRect, type CropCorner, type CropRect } from "./crop-geometry";

// Crop proposed for a photo where the local check found a face (CGU §7, privacy policy §4.4):
// the seller keeps the object and leaves the faces out of the frame. The cropped copy is drawn
// from the local file when the browser still holds it, otherwise from the published `l` variant
// (the media bucket answers CORS GET for the site's origins), then uploaded like any new photo;
// the original goes once the copy is ready (store cropPhoto). Pointer: drag the frame or a corner.
// Keyboard: arrows move the frame, Shift + arrows resize it from its bottom corner.

interface PhotoCropDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Image sources in order of preference (local object URL, then the published variant). */
  sources: readonly string[];
  index: number;
  onCropped: (file: File) => void;
}

const KEY_STEP = 0.02;
const CORNERS: readonly CropCorner[] = ["nw", "ne", "sw", "se"];

type Drag = { mode: "move" } | { mode: "resize"; corner: CropCorner };

export function PhotoCropDialog({ open, onOpenChange, sources, index, onCropped }: PhotoCropDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          data-testid="photo-crop-dialog"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col gap-4 overflow-y-auto rounded-t-lg border border-border bg-surface p-5 shadow-xl shadow-bab-950/20 outline-none sm:p-6",
            "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg rtl:sm:translate-x-1/2",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          {/* Mounted with the content: every opening starts from the proposal and the preferred source. */}
          <CropPanel sources={sources} index={index} onCropped={onCropped} onDone={() => onOpenChange(false)} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CropPanel({ sources, index, onCropped, onDone }: Pick<PhotoCropDialogProps, "sources" | "index" | "onCropped"> & { onDone: () => void }) {
  const t = useTranslations("Listing.photos.crop");
  const [rect, setRect] = useState<CropRect>(INITIAL_CROP);
  const [source, setSource] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ kind: Drag; x: number; y: number; start: CropRect } | null>(null);

  const src = sources[source];
  const unavailable = !src;

  function begin(event: PointerEvent<HTMLElement>, kind: Drag) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { kind, x: event.clientX, y: event.clientY, start: rect };
  }

  function onPointerMove(event: PointerEvent<HTMLElement>) {
    const current = drag.current;
    const box = frame.current?.getBoundingClientRect();
    if (!current || !box || box.width === 0 || box.height === 0) return;
    const dx = (event.clientX - current.x) / box.width;
    const dy = (event.clientY - current.y) / box.height;
    setRect(current.kind.mode === "move" ? moveRect(current.start, dx, dy) : resizeRect(current.start, current.kind.corner, dx, dy));
  }

  function end() {
    drag.current = null;
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-KEY_STEP, 0],
      ArrowRight: [KEY_STEP, 0],
      ArrowUp: [0, -KEY_STEP],
      ArrowDown: [0, KEY_STEP],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    setRect((current) => (event.shiftKey ? resizeRect(current, "se", move[0], move[1]) : moveRect(current, move[0], move[1])));
  }

  async function confirm() {
    const img = image.current;
    if (!img || !loaded) return;
    setBusy(true);
    setFailed(false);
    try {
      const { sx, sy, sw, sh } = cropPixels(rect, img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("toBlob failed");
      onCropped(new File([blob], `photo-${index}-recadree.jpg`, { type: "image/jpeg" }));
      onDone();
    } catch {
      // A canvas tainted by a source without CORS, or out of memory: the seller can still remove the photo.
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-1">
        <Dialog.Title className="text-lg font-semibold text-balance">{t("title", { index })}</Dialog.Title>
        <Dialog.Description className="text-sm text-foreground-muted text-pretty">{t("description")}</Dialog.Description>
      </div>

      {unavailable ? (
        <ErrorBanner tone="warning" title={t("unavailable")} />
      ) : (
        <div className="flex justify-center rounded-md bg-bab-950/90 p-2">
          {/* The frame has the image's own size: the crop rectangle maps 1:1 to its fractions. */}
          <div ref={frame} className="relative max-w-full touch-none overflow-hidden select-none" dir="ltr">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={src}
              ref={image}
              src={src}
              alt={t("imageAlt", { index })}
              crossOrigin={src.startsWith("blob:") ? undefined : "anonymous"}
              draggable={false}
              onLoad={() => setLoaded(true)}
              onError={() => {
                setLoaded(false);
                setSource((current) => current + 1);
              }}
              className="block max-h-[55dvh] w-auto max-w-full"
            />
            {loaded ? (
              <div
                role="group"
                tabIndex={0}
                aria-label={t("frameLabel")}
                aria-describedby="photo-crop-keys"
                data-testid="photo-crop-frame"
                onKeyDown={onKeyDown}
                onPointerDown={(event) => begin(event, { mode: "move" })}
                onPointerMove={onPointerMove}
                onPointerUp={end}
                onPointerCancel={end}
                className="absolute cursor-move rounded-[2px] outline-2 outline-cream-100 shadow-[0_0_0_9999px_rgb(10_14_12/0.6)] focus-visible:outline-3 focus-visible:outline-featured"
                style={{
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.w * 100}%`,
                  height: `${rect.h * 100}%`,
                }}
              >
                {/* Rule of thirds: helps centre the object. */}
                <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 start-1/3 w-px bg-cream-100/40" />
                <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 start-2/3 w-px bg-cream-100/40" />
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-cream-100/40" />
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-cream-100/40" />
                {CORNERS.map((corner) => (
                  <span
                    key={corner}
                    aria-hidden="true"
                    data-corner={corner}
                    onPointerDown={(event) => begin(event, { mode: "resize", corner })}
                    onPointerMove={onPointerMove}
                    onPointerUp={end}
                    onPointerCancel={end}
                    className={cn(
                      "absolute flex size-11 items-center justify-center",
                      corner === "nw" && "-top-5.5 -left-5.5 cursor-nwse-resize",
                      corner === "ne" && "-top-5.5 -right-5.5 cursor-nesw-resize",
                      corner === "sw" && "-bottom-5.5 -left-5.5 cursor-nesw-resize",
                      corner === "se" && "-right-5.5 -bottom-5.5 cursor-nwse-resize",
                    )}
                  >
                    <span className="size-4 rounded-full border-2 border-bab-950 bg-cream-100 shadow-sm" />
                  </span>
                ))}
              </div>
            ) : (
              <span className="absolute inset-0 flex items-center justify-center text-cream-100">
                <Spinner className="size-6" />
              </span>
            )}
          </div>
        </div>
      )}
      <p id="photo-crop-keys" className="text-xs text-foreground-muted">
        {t("keys")}
      </p>
      {failed ? <ErrorBanner title={t("failed")} /> : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Dialog.Close asChild>
          <Button type="button" variant="outline">
            {t("cancel")}
          </Button>
        </Dialog.Close>
        <Button type="button" loading={busy} disabled={!loaded || unavailable} onClick={() => void confirm()}>
          {t("confirm")}
        </Button>
      </div>
    </>
  );
}
