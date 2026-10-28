import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const inputClassName = cn(
  "h-11 w-full min-w-0 rounded-md border border-border-control bg-surface px-3 text-base text-foreground",
  "placeholder:text-foreground-muted transition-[border-color,box-shadow] duration-150 ease-door",
  "focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25",
  "aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/20",
  "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-70",
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, type = "text", ...props },
  ref,
) {
  return <input ref={ref} type={type} className={cn(inputClassName, className)} {...props} />;
});
