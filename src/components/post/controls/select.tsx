import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { inputClassName } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Native select (the OS picker is the best control on a phone) with the field styling. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...props }, ref) {
  return (
    <div className="relative">
      <select ref={ref} className={cn(inputClassName, "appearance-none pe-10", className)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute end-3 top-1/2 size-5 -translate-y-1/2 text-foreground-muted" aria-hidden="true" />
    </div>
  );
});
