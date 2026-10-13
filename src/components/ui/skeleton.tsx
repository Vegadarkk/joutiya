import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** Placeholder block while content loads; hidden from assistive technology. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("skeleton-shimmer rounded-md", className)} {...props} />;
}
