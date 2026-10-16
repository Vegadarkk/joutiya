"use client";

import { Info } from "lucide-react";
import { Popover } from "radix-ui";
import { cn } from "@/lib/utils";

/** Info button next to a sponsored section heading: what an À la Une slot is (§8). */
export function SponsoredInfo({ label, text, className }: { label: string; text: string; className?: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-foreground-muted transition-colors duration-150 ease-door hover:bg-surface hover:text-foreground sm:size-9",
            "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25",
            className,
          )}
        >
          <Info className="size-4" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={16}
          className="z-50 max-w-72 rounded-md border border-border bg-surface px-3 py-2.5 text-sm text-foreground shadow-lg shadow-bab-950/15 text-pretty data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          {text}
          <Popover.Arrow className="fill-surface" width={12} height={6} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
