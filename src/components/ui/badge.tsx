import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      neutral: "bg-surface-muted text-foreground-muted",
      // "À la Une · Sponsorisé" and "Remontée" (§7, référencement): gold, the threshold of the door.
      featured: "bg-featured text-featured-foreground",
      pro: "bg-structure text-structure-foreground",
      success: "bg-success-surface text-success",
      warning: "bg-warning-surface text-warning",
      danger: "bg-danger-surface text-danger",
    },
  },
  defaultVariants: { variant: "neutral" },
});

export function Badge({ className, variant, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
