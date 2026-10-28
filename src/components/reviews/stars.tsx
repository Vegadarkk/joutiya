import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

// A rating as five stars (vitrine-avis §2): gold fill to the nearest half, the rest outlined.
// Decorative: the caller gives the words ("4,5 sur 5") next to it or as `label`.

const SIZES = { sm: "size-4", md: "size-5", lg: "size-7" } as const;

export function Stars({ value, size = "sm", label, className }: { value: number; size?: keyof typeof SIZES; label?: string; className?: string }) {
  const halves = Math.round(value * 2);
  return (
    <span role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className={cn("inline-flex shrink-0 items-center gap-0.5", className)}>
      {[1, 2, 3, 4, 5].map((index) => {
        const fill = halves >= index * 2 ? "full" : halves === index * 2 - 1 ? "half" : "empty";
        return (
          <span key={index} className={cn("relative inline-flex", SIZES[size])}>
            <Star className={cn("size-full", fill === "full" ? "fill-featured text-featured" : "text-border-strong")} strokeWidth={1.75} aria-hidden="true" />
            {fill === "half" ? (
              <span className="absolute inset-y-0 start-0 w-1/2 overflow-hidden">
                <Star className={cn("fill-featured text-featured", SIZES[size])} strokeWidth={1.75} aria-hidden="true" />
              </span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}
