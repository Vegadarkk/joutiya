"use client";

import { useSyncExternalStore } from "react";

// The combination a buyer picked on a listing page (« M / Noir »), shared by the picker and the
// contact bar: the first message names it. Per listing id, in memory only (a reload starts over).

const selections = new Map<string, string>();
const listeners = new Set<() => void>();

export function setVariantSelection(listingId: string, label: string | null): void {
  if (label === null) selections.delete(listingId);
  else selections.set(listingId, label);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The picked combination's name, or null (nothing picked, or no variants). */
export function useVariantSelection(listingId: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => selections.get(listingId) ?? null,
    () => null,
  );
}
