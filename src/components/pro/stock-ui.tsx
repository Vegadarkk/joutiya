"use client";

import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Building blocks of the stock import page (/pro/stock): a numbered step and a file drop zone.

/** A numbered step of the import: the steps are a real sequence. */
export function Step({ index, title, lead, muted = false, children }: { index: number; title: string; lead?: string; muted?: boolean; children?: ReactNode }) {
  return (
    <li className="relative grid grid-cols-[2.5rem_1fr] gap-x-4">
      <span aria-hidden="true" className={cn("flex size-10 items-center justify-center rounded-full border-2 text-base font-semibold tabular-nums", muted ? "border-border text-foreground-muted" : "border-structure bg-structure text-structure-foreground")}>
        {index}
      </span>
      <div className="flex min-w-0 flex-col gap-4">
        <header className="flex min-h-10 flex-col justify-center gap-1">
          <h2 className="text-xl font-semibold text-balance">{title}</h2>
          {lead ? <p className="text-sm text-foreground-muted text-pretty">{lead}</p> : null}
        </header>
        {children}
      </div>
    </li>
  );
}

/** A drop zone that is also a file button (keyboard and screen readers use the button). */
export function FileDrop({ accept, multiple = false, label, hint, icon, onFiles, busy = false }: { accept: string; multiple?: boolean; label: string; hint: string; icon: ReactNode; onFiles: (files: File[]) => void; busy?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  function drop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) onFiles(files);
  }
  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={cn("flex flex-col items-center gap-3 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors", over ? "border-structure bg-surface-brand" : "border-border-strong bg-surface")}
    >
      <span className="text-structure dark:text-bab-300">{icon}</span>
      <Button variant="structure" loading={busy} onClick={() => input.current?.click()}>
        {label}
      </Button>
      <p className="max-w-prose text-sm text-foreground-muted text-pretty">{hint}</p>
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        tabIndex={-1}
        aria-label={label}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </div>
  );
}
