"use client";

import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// The listings of a storefront (vitrine-avis §1), sorted and filtered in the browser: the cards are
// rendered by the server (ISR page, nothing fetched here) and only reordered. Labels come
// translated from the page, so no message namespace ships to the client.

export const SHELF_SORTS = ["recent", "priceAsc", "priceDesc"] as const;
export type ShelfSort = (typeof SHELF_SORTS)[number];

export interface ShelfItem {
  id: string;
  /** null: donation or price to discuss, listed after the priced ones. */
  price: number | null;
  /** ISO 8601. */
  sortAt: string;
  categoryId: string | null;
  node: ReactNode;
}

export interface ShelfLabels {
  sort: string;
  sorts: Record<ShelfSort, string>;
  filter: string;
  all: string;
  /** Category id -> name, for the categories present. */
  categories: Record<string, string>;
}

export function sortShelf<T extends Pick<ShelfItem, "price" | "sortAt">>(items: readonly T[], sort: ShelfSort): T[] {
  const out = [...items];
  if (sort === "recent") return out.sort((a, b) => b.sortAt.localeCompare(a.sortAt));
  const sign = sort === "priceAsc" ? 1 : -1;
  return out.sort((a, b) => {
    if (a.price === null || b.price === null) return a.price === b.price ? b.sortAt.localeCompare(a.sortAt) : a.price === null ? 1 : -1;
    return a.price === b.price ? b.sortAt.localeCompare(a.sortAt) : sign * (a.price - b.price);
  });
}

const chip = "inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors";

export function ListingShelf({ items, labels }: { items: ShelfItem[]; labels: ShelfLabels }) {
  const [sort, setSort] = useState<ShelfSort>("recent");
  const [category, setCategory] = useState<string | null>(null);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of items) if (item.categoryId) map.set(item.categoryId, (map.get(item.categoryId) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);
  const shown = useMemo(() => sortShelf(category ? items.filter((item) => item.categoryId === category) : items, sort), [items, category, sort]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {counts.length > 1 ? (
          <div role="group" aria-label={labels.filter} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
            <button type="button" aria-pressed={category === null} onClick={() => setCategory(null)} className={cn(chip, "shrink-0", category === null ? "border-structure bg-structure text-structure-foreground" : "border-border-control bg-surface hover:bg-surface-muted")}>
              {labels.all}
              <span className="tabular-nums opacity-75">{items.length}</span>
            </button>
            {counts.map(([id, count]) => (
              <button key={id} type="button" aria-pressed={category === id} onClick={() => setCategory(category === id ? null : id)} className={cn(chip, "shrink-0", category === id ? "border-structure bg-structure text-structure-foreground" : "border-border-control bg-surface hover:bg-surface-muted")}>
                {labels.categories[id] ?? id}
                <span className="tabular-nums opacity-75">{count}</span>
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        {items.length > 1 ? (
          <label className="flex shrink-0 items-center gap-2 text-sm text-foreground-muted">
            {labels.sort}
            <select value={sort} onChange={(event) => setSort(event.target.value as ShelfSort)} className="min-h-10 rounded-md border border-border-control bg-surface px-3 text-sm font-medium text-foreground">
              {SHELF_SORTS.map((key) => (
                <option key={key} value={key}>
                  {labels.sorts[key]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 sm:gap-x-4 lg:grid-cols-4">
        {shown.map((item) => (
          <li key={item.id} className="min-w-0">
            {item.node}
          </li>
        ))}
      </ul>
    </div>
  );
}
