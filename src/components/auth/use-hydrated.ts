"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False on the server render and until React hydrates the form, then true. The auth forms keep
 * their submit button disabled until then: submitted earlier, the browser would send the fields
 * itself, with no validation, Turnstile or CSRF header.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
