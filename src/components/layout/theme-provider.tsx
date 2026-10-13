"use client";

import type { ReactNode } from "react";
import { ThemeProvider as NextThemes } from "next-themes";

/**
 * Light, dark or system. The pre-paint script is inline: hashed on public pages by the CSP hook,
 * stamped with the request nonce on private pages.
 */
export function ThemeProvider({ children, nonce }: { children: ReactNode; nonce?: string }) {
  return (
    <NextThemes attribute="data-theme" defaultTheme="system" enableSystem disableTransitionOnChange nonce={nonce}>
      {children}
    </NextThemes>
  );
}
