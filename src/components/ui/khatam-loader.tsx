import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// The loading mark of the site (Carte vivante, lot 1): the khatam of the logo's door turning
// slowly, in gold (gold-500 on light grounds, gold-300 on dark), still under reduced motion
// (globals.css `khatam`). Decorative by default: give it a `label` when it is the only sign that
// something loads, and it becomes a status with that text for screen readers.

const khatamVariants = cva("khatam", {
  variants: {
    size: {
      /** Inline with text or inside a button: follows the font size. */
      inline: "size-[1.1em] [--khatam-stroke:0.1em]",
      sm: "size-5 [--khatam-stroke:1.75px]",
      md: "size-[2.125rem] [--khatam-stroke:2.5px]",
      lg: "size-12 [--khatam-stroke:3px]",
    },
    tone: {
      gold: "text-gold-500 dark:text-gold-300",
      /** The colour of the surrounding text (buttons, photo overlays). */
      current: "",
    },
  },
  defaultVariants: { size: "md", tone: "gold" },
});

export interface KhatamLoaderProps extends VariantProps<typeof khatamVariants> {
  /** Announced as a status ("Chargement…"); without it the mark is hidden from assistive technology. */
  label?: string;
  className?: string;
}

export function KhatamLoader({ label, size, tone, className }: KhatamLoaderProps) {
  const mark = <span aria-hidden="true" data-loader="khatam" className={cn(khatamVariants({ size, tone }), label ? undefined : className)} />;
  if (!label) return mark;
  return (
    <span role="status" className={cn("inline-flex", className)}>
      {mark}
      <span className="sr-only">{label}</span>
    </span>
  );
}
