"use client";

import { Toaster as Sonner } from "sonner";
import { useTheme } from "@/components/layout/theme";
import { cn } from "@/lib/utils";

/**
 * Enter and exit of a toast: opacity and 8 px in 200 ms on the door curve, instead of sonner's
 * full-height slide in 400 ms (cut short by its 200 ms unmount on exit). Sonner (2.0.8) positions
 * a toast with `--y` in an unlayered stylesheet, so these declarations are important: an important
 * layered rule wins over a normal unlayered one. Stacked toasts keep sonner's own offsets; reduced
 * motion keeps sonner's and the global rule (no transition).
 */
export const toastMotionClassName = cn(
  "motion-safe:[transition-duration:200ms]! motion-safe:[transition-timing-function:var(--ease-door)]!",
  "motion-safe:data-[mounted=false]:[--y:translateY(-8px)]!",
  "motion-safe:data-[removed=true]:data-[front=true]:data-[swipe-out=false]:[--y:translateY(-8px)]!",
);

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
      toastOptions={{ className: cn("font-sans", toastMotionClassName), duration: 5000 }}
    />
  );
}
