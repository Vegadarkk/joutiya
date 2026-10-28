"use client";

import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Circle, CircleCheck, Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { inputClassName } from "@/components/ui/input";
import { passwordRules } from "@/lib/auth/password-rules";
import { PASSWORD_MIN } from "@/lib/contracts/auth";
import { cn } from "@/lib/utils";

// Password input with show/hide and, for a new password, the rules ticked live. The rules are the
// server's own (src/lib/auth/password-rules.ts), so a password the browser accepts is never refused
// as weak by the API, except for a display name the page does not know (reset).

export interface PasswordFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  /** Shown at the end of the label row ("Mot de passe oublié ?"). */
  labelAside?: ReactNode;
  error?: ReactNode;
  hint?: ReactNode;
  /** New password: ticks the rules as the value changes; `email` and `displayName` feed the "personal" rule. */
  rules?: { value: string; email?: string; displayName?: string };
}

export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(function PasswordField(
  { label, labelAside, error, hint, rules, className, required, id: idProp, ...props },
  ref,
) {
  const t = useTranslations("Auth.common");
  const generated = useId();
  const id = idProp ?? generated;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const rulesId = `${id}-rules`;
  const [visible, setVisible] = useState(false);
  const checks = rules ? passwordRules(rules.value, { email: rules.email, displayName: rules.displayName }) : null;
  const describedBy = [error ? errorId : hint ? hintId : null, checks ? rulesId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3">
        {/* The marker sits outside the <label>, so the accessible name stays exactly the label text. */}
        <span className="text-sm font-medium text-foreground">
          <label htmlFor={id}>{label}</label>
          {required ? (
            <span className="ms-0.5 text-danger" aria-hidden="true">
              *
            </span>
          ) : null}
        </span>
        {labelAside ? <span className="text-sm">{labelAside}</span> : null}
      </div>
      <div className="relative">
        {/* Passwords are Latin-script by nature: left to right even on the Arabic interface. */}
        <input
          ref={ref}
          id={id}
          type={visible ? "text" : "password"}
          dir="ltr"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          aria-required={required || undefined}
          className={cn(inputClassName, "pe-12 text-start")}
          {...props}
        />
        {/* The label names the action that the click performs; no pressed state on top of it. */}
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? t("hidePassword") : t("showPassword")}
          className="absolute end-1 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-sm text-foreground-muted transition-[background-color,color,scale] duration-150 ease-door hover:bg-surface-muted hover:text-foreground active:scale-[0.98]"
        >
          {visible ? <EyeOff className="size-5" aria-hidden="true" /> : <Eye className="size-5" aria-hidden="true" />}
        </button>
      </div>
      {error ? (
        <InlineError id={errorId}>{error}</InlineError>
      ) : hint ? (
        <p id={hintId} className="text-sm text-foreground-muted">
          {hint}
        </p>
      ) : null}
      {checks ? (
        <ul id={rulesId} aria-label={t("hints.title")} className="mt-1 flex flex-col gap-1 text-sm">
          <Rule ok={checks.length}>{t("hints.length", { min: PASSWORD_MIN })}</Rule>
          <Rule ok={checks.common}>{t("hints.common")}</Rule>
          <Rule ok={checks.personal}>{t("hints.personal")}</Rule>
        </ul>
      ) : null}
    </div>
  );
});

function Rule({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className={cn("flex items-center gap-2 transition-colors duration-150 ease-door", ok ? "text-success" : "text-foreground-muted")}>
      {ok ? <CircleCheck className="size-4 shrink-0" aria-hidden="true" /> : <Circle className="size-4 shrink-0" aria-hidden="true" />}
      <span>{children}</span>
    </li>
  );
}
