"use client";

import { useId, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { BadgePercent } from "lucide-react";
import { radioKeyTarget } from "@/components/post/controls/chips";
import { cn } from "@/lib/utils";

// The shelves of a shop's storefront (catalogue §5): « Tout », its sections, « Promotions ». The
// panels are rendered on the server (ISR), every one in the HTML; the tabs only show one. The
// hash names the shelf (#rayon-ramada, #promotions), so a shop can share a link to a section.

export interface StorefrontTab {
  key: string;
  label: string;
  count: number;
  promo?: boolean;
}

const hashOf = (tab: StorefrontTab) => (tab.promo ? "promotions" : tab.key === "all" ? "" : `rayon-${tab.key}`);

// The hash is the state: a shared link opens its shelf after hydration (the HTML shows « Tout », as
// without JavaScript), and a choice rewrites it without a history entry.
const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("hashchange", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("hashchange", listener);
  };
}
function setHash(hash: string): void {
  window.history.replaceState(window.history.state, "", hash ? `#${hash}` : window.location.pathname + window.location.search);
  for (const listener of listeners) listener();
}

export function StorefrontTabs({ label, tabs, panels }: { label: string; tabs: StorefrontTab[]; panels: ReactNode[] }) {
  const id = useId();
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash.slice(1),
    () => "",
  );
  const current = Math.max(0, hash ? tabs.findIndex((tab) => hashOf(tab) === hash) : 0);

  function choose(index: number) {
    const tab = tabs[index];
    if (tab) setHash(hashOf(tab));
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const target = radioKeyTarget(event.key, index, tabs.length, rtl);
    if (target === null) return;
    event.preventDefault();
    choose(target);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
  }

  return (
    <div className="flex flex-col gap-6">
      <div role="tablist" aria-label={label} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
        {tabs.map((tab, index) => {
          const selected = index === current;
          return (
            <button
              key={tab.key}
              id={`${id}-tab-${index}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${id}-panel-${index}`}
              tabIndex={selected ? 0 : -1}
              data-testid="storefront-tab"
              onClick={() => choose(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={cn(
                "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium whitespace-nowrap",
                "transition-[background-color,border-color,color,scale] duration-150 ease-door active:scale-[0.98]",
                selected ? "border-structure bg-structure text-structure-foreground" : "border-border-control bg-surface hover:bg-surface-muted",
                !selected && tab.promo && "border-danger/40 text-danger",
              )}
            >
              {tab.promo ? <BadgePercent className="size-4" aria-hidden="true" /> : null}
              <span dir="auto">{tab.label}</span>
              <span className={cn("rounded-full px-1.5 text-xs tabular-nums", selected ? "bg-structure-foreground/15" : "bg-surface-muted text-foreground-muted")}>{tab.count}</span>
            </button>
          );
        })}
      </div>
      {panels.map((panel, index) => (
        <div key={tabs[index]?.key ?? index} id={`${id}-panel-${index}`} role="tabpanel" aria-labelledby={`${id}-tab-${index}`} hidden={index !== current} className="flex flex-col gap-6">
          {panel}
        </div>
      ))}
    </div>
  );
}
