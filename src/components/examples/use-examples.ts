"use client";

import { useSyncExternalStore } from "react";
import { EXAMPLES_ATTRIBUTE, EXAMPLES_COOKIE, EXAMPLES_COOKIE_SECONDS, EXAMPLES_HIDDEN } from "@/lib/examples/script";

// The « Masquer les annonces exemples » choice of this device (src/lib/examples/script.ts): the
// cookie the server reads, mirrored on html[data-examples] for the pages rendered once for everyone.

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const hiddenNow = () => document.documentElement.getAttribute(EXAMPLES_ATTRIBUTE) === EXAMPLES_HIDDEN;

/** True when this device hides the example listings (false on the server and during hydration). */
export function useExamplesHidden(): boolean {
  return useSyncExternalStore(subscribe, hiddenNow, () => false);
}

/** Records the choice for 400 days (or clears it) and applies it to the page at once. */
export function setExamplesHidden(hidden: boolean): void {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = hidden
    ? `${EXAMPLES_COOKIE}=${EXAMPLES_HIDDEN}; Path=/; Max-Age=${EXAMPLES_COOKIE_SECONDS}; SameSite=Lax${secure}`
    : `${EXAMPLES_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  const root = document.documentElement;
  if (hidden) root.setAttribute(EXAMPLES_ATTRIBUTE, EXAMPLES_HIDDEN);
  else root.removeAttribute(EXAMPLES_ATTRIBUTE);
  for (const listener of listeners) listener();
}
