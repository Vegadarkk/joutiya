"use client";

import type { ReactNode } from "react";
import { Direction } from "radix-ui";
import { ThemeSync } from "./theme";
import { Toaster } from "@/components/ui/toaster";
import { SentryClient } from "@/components/observability/sentry-client";
import { PublicConfigProvider } from "@/lib/config/client";
import type { PublicConfig } from "@/lib/config/public-types";

/**
 * Client providers of both root layouts. `config` is given by the private (dynamic) layout; the
 * static public layout passes none and the browser fetches /api/config when a component needs it.
 */
export function Providers({ children, dir, config }: { children: ReactNode; dir: "ltr" | "rtl"; config?: PublicConfig }) {
  return (
    <Direction.Provider dir={dir}>
      <PublicConfigProvider value={config}>
        <ThemeSync />
        <SentryClient />
        {children}
        <Toaster dir={dir} />
      </PublicConfigProvider>
    </Direction.Provider>
  );
}
