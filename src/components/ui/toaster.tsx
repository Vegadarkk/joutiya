"use client";

import { useTranslations } from "next-intl";
import { Toaster as Sonner } from "sonner";
import { useTheme } from "@/components/layout/theme";

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
      toastOptions={{ className: "font-sans", duration: 5000, closeButtonAriaLabel: labels.close }}
    />
  );
}
