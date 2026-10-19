import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Placeholder block while content loads; hidden from assistive technology. Reduced motion gets a
 * flat block: no shine sweep, not even one frozen half-way.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("skeleton-shimmer rounded-md motion-reduce:animate-none motion-reduce:bg-none motion-reduce:bg-skeleton", className)} {...props} />;
}
