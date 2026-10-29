import { useSyncExternalStore } from "react";
import type { LocationValue } from "@/components/search/location";

// The search page's hold on the header pill (Carte vivante, lot 2): /recherche has no search band of
// its own; it fills the header pill with the current words and place, carries its other filters in
// the pill's form and runs the submit as its own navigation. Plain values only, so the header (on
// every page) never imports the search parameters module.

export interface HeaderSearchBinding {
  /** Changes with the search: the pill's fields start again from the values below. */
  key: string;
  q: string;
  place: LocationValue;
  /** Hidden inputs of the GET form: every other filter of the current search (no-JS submit). */
  carried: readonly (readonly [string, string])[];
  /** Hydrated submit: the page navigates in a transition, keeping its filters. */
  submit: (q: string, place: LocationValue) => void;
}

let binding: HeaderSearchBinding | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Called by the search page; returns the release (a later binding is left alone). */
export function bindHeaderSearch(next: HeaderSearchBinding): () => void {
  binding = next;
  emit();
  return () => {
    if (binding !== next) return;
    binding = null;
    emit();
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => binding;
const serverSnapshot = () => null;

export function useHeaderSearchBinding(): HeaderSearchBinding | null {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
