import { forwardRef, type TextareaHTMLAttributes } from "react";
import { inputClassName } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Multi-line input that grows with its content (CSS `field-sizing`; `rows` is the floor). */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, rows = 5, ...props }, ref) {
  return <textarea ref={ref} rows={rows} className={cn(inputClassName, "h-auto min-h-32 resize-y py-2.5 leading-relaxed field-sizing-content", className)} {...props} />;
});
