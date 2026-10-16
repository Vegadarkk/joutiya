"use client";

import type { ReactNode } from "react";
import { Direction } from "radix-ui";
import { ThemeSync } from "./theme";
import { Toaster } from "@/components/ui/toaster";
import { SentryClient } from "@/components/observability/sentry-client";
import { InitialSessionContext } from "@/lib/auth/client";
import { PublicConfigProvider } from "@/lib/config/client";
import type { PublicConfig } from "@/lib/config/public-types";
import type { SessionSummary } from "@/lib/contracts/auth";

/**
 * Client providers of both root layouts. `config` and `initialSession` are given by the private
 * (dynamic) layout; the static public layout passes neither, and the browser fetches /api/config
 * and /api/auth/me when a component needs them.
 */
export function Providers({
  children,
  dir,
  config,
  initialSession,
}: {
  children: ReactNode;
  dir: "ltr" | "rtl";
  config?: PublicConfig;
  /** The session the server rendered with (null = anonymous); undefined when unknown. */
  initialSession?: SessionSummary | null;
}) {
  return (
    <Direction.Provider dir={dir}>
      <PublicConfigProvider value={config}>
        <InitialSessionContext.Provider value={initialSession}>
          <ThemeSync />
          <SentryClient />
          {children}
          <Toaster dir={dir} />
        </InitialSessionContext.Provider>
      </PublicConfigProvider>
    </Direction.Provider>
  );
}
