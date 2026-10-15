"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { PublicConfig } from "./public-types";

// Runtime browser configuration. Private pages (dynamic) receive it from their layout; public
// pages (built once, shared by staging and production) fetch /api/config on first use.

const ConfigContext = createContext<PublicConfig | null>(null);
let pending: Promise<PublicConfig> | undefined;

export function loadPublicConfig(): Promise<PublicConfig> {
  pending ??= fetch("/api/config", { credentials: "same-origin" }).then((response) => {
    if (!response.ok) throw new Error(`config: HTTP ${response.status}`);
    return response.json() as Promise<PublicConfig>;
  });
  pending.catch(() => {
    pending = undefined;
  });
  return pending;
}

export function PublicConfigProvider({ value, children }: { value?: PublicConfig; children: ReactNode }) {
  if (value) pending ??= Promise.resolve(value);
  return <ConfigContext.Provider value={value ?? null}>{children}</ConfigContext.Provider>;
}

/** The configuration, or null while it loads (public pages) or if it cannot be fetched. */
export function usePublicConfig(): PublicConfig | null {
  const seeded = useContext(ConfigContext);
  const [loaded, setLoaded] = useState<PublicConfig | null>(null);
  useEffect(() => {
    if (seeded) return;
    let active = true;
    loadPublicConfig().then(
      (config) => active && setLoaded(config),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [seeded]);
  return seeded ?? loaded;
}
