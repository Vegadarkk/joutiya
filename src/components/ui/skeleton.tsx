import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Placeholder block while content loads; hidden from assistive technology. A still cream wash with
 * no shine sweep: the page's khatam loader (khatam-loader.tsx) shows that something is coming.
 */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("rounded-md bg-skeleton", className)} {...props} />;
}
