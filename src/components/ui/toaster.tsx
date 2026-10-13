"use client";

import { Toaster as Sonner } from "sonner";
import { useTheme } from "@/components/layout/theme";

/** Toasts at the top end of the screen; direction and theme follow the page. */
export function Toaster({ dir }: { dir: "ltr" | "rtl" }) {
  const { resolvedTheme } = useTheme();
  return (
    <Sonner
      dir={dir}
      theme={resolvedTheme}
      position={dir === "rtl" ? "top-left" : "top-right"}
      closeButton
      richColors
      toastOptions={{ className: "font-sans", duration: 5000 }}
    />
  );
}
