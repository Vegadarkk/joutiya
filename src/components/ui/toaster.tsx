"use client";

import { useTranslations } from "next-intl";
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

/** Accessible names of the notification region and of each toast's close button (sonner defaults to English). */
export interface ToasterLabels {
  region: string;
  close: string;
}

/** Toasts at the top end of the screen; direction and theme follow the page, labels the Toaster namespace. */
export function Toaster({ dir }: { dir: "ltr" | "rtl" }) {
  const t = useTranslations("Toaster");
  return <LabelledToaster dir={dir} labels={{ region: t("region"), close: t("close") }} />;
}

/** The same container with labels from the caller: the back office renders no intl provider. */
export function LabelledToaster({ dir, labels }: { dir: "ltr" | "rtl"; labels: ToasterLabels }) {
  const { resolvedTheme } = useTheme();
  return (
    <Sonner
      dir={dir}
      theme={resolvedTheme}
      position={dir === "rtl" ? "top-left" : "top-right"}
      closeButton
      richColors
      containerAriaLabel={labels.region}
      toastOptions={{ className: cn("font-sans", toastMotionClassName), duration: 5000, closeButtonAriaLabel: labels.close }}
    />
  );
}
