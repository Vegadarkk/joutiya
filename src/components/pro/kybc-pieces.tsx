"use client";

import { useId, useRef, useState } from "react";
import { FileCheck2, FileText, FileWarning, Paperclip, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import type { KybcRejectReason } from "@/lib/contracts/pro";
import { KYBC_MAX_PIECES } from "@/lib/pro/kybc";
import { removeKybcPiece, uploadKybcPiece } from "@/lib/pro/client";
import { cn } from "@/lib/utils";

// KYBC pieces of the application (design §4): each file is sent as soon as it is chosen (sign,
// PUT, complete) and shows its own state; only `ready` pieces go in the application. A piece
// removed from the list is deleted on the server too (its private copy would otherwise stay 7
// days). The collection notice (purpose, who reads them, retention, rights: loi 09-08 art. 5)
// and the CNIE masking instruction sit above the list, before the first file is chosen.

export type PieceState =
  | { key: string; name: string; phase: "uploading"; progress: number }
  | { key: string; name: string; phase: "ready"; uploadId: string }
  | { key: string; name: string; phase: "rejected"; reason: KybcRejectReason | "failed" };

interface KybcPiecesProps {
  pieces: PieceState[];
  onChange: (update: (pieces: PieceState[]) => PieceState[]) => void;
  error?: string;
}

let sequence = 0;

export function KybcPieces({ pieces, onChange, error }: KybcPiecesProps) {
  const t = useTranslations("Pro.form");
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [busy, setBusy] = useState(0);
  const kept = pieces.filter((piece) => piece.phase !== "rejected").length;

  async function send(file: File) {
    sequence += 1;
    const key = `piece-${sequence}`;
    const set = (next: PieceState) => onChange((list) => list.map((piece) => (piece.key === key ? next : piece)));
    onChange((list) => [...list, { key, name: file.name, phase: "uploading", progress: 0 }]);
    setBusy((count) => count + 1);
    try {
      const result = await uploadKybcPiece(file, (fraction) => set({ key, name: file.name, phase: "uploading", progress: fraction }));
      set(result.status === "ready" ? { key, name: file.name, phase: "ready", uploadId: result.uploadId } : { key, name: file.name, phase: "rejected", reason: result.reason });
    } catch {
      set({ key, name: file.name, phase: "rejected", reason: "failed" });
    } finally {
      setBusy((count) => count - 1);
    }
  }

  function remove(piece: PieceState) {
    onChange((list) => list.filter((item) => item.key !== piece.key));
    // Best effort: a copy left behind is purged by the server after 7 days anyway.
    if (piece.phase === "ready") void removeKybcPiece(piece.uploadId).catch(() => undefined);
  }

  function choose(files: FileList | null) {
    if (!files) return;
    const room = KYBC_MAX_PIECES - kept;
    for (const file of [...files].slice(0, Math.max(0, room))) void send(file);
    if (input.current) input.current.value = "";
  }

  return (
    <div className="flex flex-col gap-4" aria-describedby={error ? errorId : undefined}>
      <p className="text-sm text-pretty text-foreground-muted">{t("piecesLead", { max: KYBC_MAX_PIECES })}</p>
      <p className="text-xs text-pretty text-foreground-muted">
        {t.rich("piecesNotice", {
          link: (chunks) => (
            <Link href="/legal/confidentialite" target="_blank" rel="noopener" className="font-medium text-link underline underline-offset-2">
              {chunks}
            </Link>
          ),
        })}
      </p>
      {pieces.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {pieces.map((piece) => (
            <li key={piece.key} className={cn("flex items-center gap-3 rounded-md border px-3 py-2.5", piece.phase === "rejected" ? "border-danger/30 bg-danger-surface" : "border-border bg-surface")}>
              {piece.phase === "uploading" ? (
                <Spinner className="size-5 text-foreground-muted" />
              ) : piece.phase === "ready" ? (
                <FileCheck2 className="size-5 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <FileWarning className="size-5 shrink-0 text-danger" aria-hidden="true" />
              )}
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium" dir="auto">
                  {piece.name}
                </span>
                <span role="status" className={cn("text-xs", piece.phase === "rejected" ? "text-danger" : "text-foreground-muted")}>
                  {piece.phase === "uploading"
                    ? `${t("pieceUploading")} ${Math.round(piece.progress * 100)} %`
                    : piece.phase === "ready"
                      ? t("pieceReady")
                      : piece.reason === "failed"
                        ? t("pieceFailed")
                        : t(`pieceRejected.${piece.reason}`)}
                </span>
                {piece.phase === "uploading" ? (
                  <span className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
                    <span className="block h-full rounded-full bg-structure transition-[width] duration-200" style={{ width: `${Math.round(piece.progress * 100)}%` }} />
                  </span>
                ) : null}
              </div>
              {piece.phase !== "uploading" ? (
                <Button type="button" variant="ghost" size="icon" className="size-9" onClick={() => remove(piece)} aria-label={t("removePiece", { name: piece.name })}>
                  <X aria-hidden="true" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <input ref={input} type="file" accept="application/pdf,image/jpeg,image/png" multiple aria-label={t("addPiece")} className="sr-only" tabIndex={-1} onChange={(event) => choose(event.target.files)} />
        <Button type="button" variant="outline" disabled={kept >= KYBC_MAX_PIECES} onClick={() => input.current?.click()}>
          {busy > 0 ? <Paperclip aria-hidden="true" /> : <FileText aria-hidden="true" />}
          {t("addPiece")}
        </Button>
      </div>
      {error ? <InlineError id={errorId}>{error}</InlineError> : null}
    </div>
  );
}
