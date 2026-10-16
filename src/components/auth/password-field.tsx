"use client";

import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Circle, CircleCheck, Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { inputClassName } from "@/components/ui/input";
import { PASSWORD_MIN } from "@/lib/contracts/auth";
import { cn } from "@/lib/utils";

// Password input with show/hide and, for a new password, the rules ticked live. The server
// applies the full policy (src/lib/auth/password-policy.ts); this list covers the common refusals.

const COMMON_PASSWORDS = new Set([
  "password",
  "passw0rd",
  "password1",
  "motdepasse",
  "motdepasse1",
  "azerty",
  "qwerty",
  "123456",
  "1234567",
  "12345678",
  "123456789",
  "1234567890",
  "123123123",
  "11111111",
  "00000000",
  "azertyuiop",
  "azerty123",
  "qwertyuiop",
  "qwerty123",
  "abcdefgh",
  "iloveyou",
  "bienvenue",
  "joutiya",
  "joutiya123",
  "maroc123",
  "marocmaroc",
  "casablanca",
  "football",
  "admin123",
  "welcome1",
]);

export interface PasswordChecks {
  length: boolean;
  common: boolean;
  notEmail: boolean;
}

export function passwordChecks(value: string, email?: string): PasswordChecks {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const repeated = /^(.)\1+$/.test(value);
  const sequence = normalized.length >= 6 && ("01234567890123456789".includes(normalized) || "98765432109876543210".includes(normalized));
  const local = (email ?? "").split("@")[0]?.toLowerCase() ?? "";
  const lower = value.toLowerCase();
  return {
    length: value.length >= PASSWORD_MIN,
    common: value.length > 0 && !COMMON_PASSWORDS.has(normalized) && !repeated && !sequence,
    notEmail: value.length > 0 && !(email && (lower === email.toLowerCase() || (local.length >= 3 && lower.includes(local)))),
  };
}

export interface PasswordFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  /** Shown at the end of the label row ("Mot de passe oublié ?"). */
  labelAside?: ReactNode;
  error?: ReactNode;
  hint?: ReactNode;
  /** New password: ticks the rules as the value changes; `email` adds the "differs from e-mail" rule. */
  rules?: { value: string; email?: string };
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
  const checks = rules ? passwordChecks(rules.value, rules.email) : null;
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
        <input
          ref={ref}
          id={id}
          type={visible ? "text" : "password"}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          aria-required={required || undefined}
          className={cn(inputClassName, "pe-12")}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? t("hidePassword") : t("showPassword")}
          aria-pressed={visible}
          className="absolute end-1 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-sm text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground"
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
          {rules?.email !== undefined ? <Rule ok={checks.notEmail}>{t("hints.notEmail")}</Rule> : null}
        </ul>
      ) : null}
    </div>
  );
});

function Rule({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className={cn("flex items-center gap-2 transition-colors", ok ? "text-success" : "text-foreground-muted")}>
      {ok ? <CircleCheck className="size-4 shrink-0" aria-hidden="true" /> : <Circle className="size-4 shrink-0" aria-hidden="true" />}
      <span>{children}</span>
    </li>
  );
}
