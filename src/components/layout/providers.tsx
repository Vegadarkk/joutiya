"use client";

import type { ReactNode } from "react";
import { Direction } from "radix-ui";
import { ThemeProvider } from "./theme-provider";
import { Toaster } from "@/components/ui/toaster";

export function Providers({ children, dir, nonce }: { children: ReactNode; dir: "ltr" | "rtl"; nonce?: string }) {
  return (
    <ThemeProvider nonce={nonce}>
      <Direction.Provider dir={dir}>
        {children}
        <Toaster dir={dir} />
      </Direction.Provider>
    </ThemeProvider>
  );
}
