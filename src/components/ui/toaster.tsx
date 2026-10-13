"use client";

import { Toaster as Sonner } from "sonner";
import { useTheme } from "next-themes";

/** Toasts at the top end of the screen; direction and theme follow the page. */
export function Toaster({ dir }: { dir: "ltr" | "rtl" }) {
  const { resolvedTheme } = useTheme();
  return (
    <Sonner
      dir={dir}
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      position={dir === "rtl" ? "top-left" : "top-right"}
      closeButton
      richColors
      toastOptions={{ className: "font-sans", duration: 5000 }}
    />
  );
}
