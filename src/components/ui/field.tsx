import { useId, type ReactElement, type ReactNode } from "react";
import { cloneElement, isValidElement } from "react";
import { cn } from "@/lib/utils";
import { InlineError } from "@/components/feedback/inline-error";

interface FieldProps {
  label: ReactNode;
  /** Shown under the control while there is no error. */
  hint?: ReactNode;
  /** Validation message: marks the control invalid and is announced by screen readers. */
  error?: ReactNode;
  required?: boolean;
  className?: string;
  /** A single form control; it receives id, aria-invalid and aria-describedby. */
  children: ReactElement<Record<string, unknown>>;
}

export function Field({ label, hint, error, required, className, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
        "aria-required": required || undefined,
      })
    : children;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
        {required ? <span className="ms-0.5 text-danger" aria-hidden="true">*</span> : null}
      </label>
      {control}
      {error ? (
        <InlineError id={errorId}>{error}</InlineError>
      ) : hint ? (
        <p id={hintId} className="text-sm text-foreground-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
