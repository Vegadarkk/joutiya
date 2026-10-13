"use client";

import type { ReactNode } from "react";
import { Direction } from "radix-ui";
import { ThemeSync } from "./theme";
import { Toaster } from "@/components/ui/toaster";

export function Providers({ children, dir }: { children: ReactNode; dir: "ltr" | "rtl" }) {
  return (
    <Direction.Provider dir={dir}>
      <ThemeSync />
      {children}
      <Toaster dir={dir} />
    </Direction.Provider>
  );
}
