"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { FieldError } from "react-hook-form";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { ApiError, type ApiErrorCode } from "@/lib/auth/client";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/contracts/auth";

// Translates API errors (`{ error: { code } }`) and zod field errors (issue codes) into the
// messages of Auth.errors and Auth.common.validation. Codes stay the contract; words live here.

/** "dans 5 minutes" / "خلال 5 دقائق" from a Retry-After in seconds. */
export function formatWait(locale: string, seconds: number | undefined, fallback: string): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return fallback;
  // Tarifit has no Intl data: the French form is used, as elsewhere in the fallback chain.
  const formatter = new Intl.RelativeTimeFormat(locale === "ar" ? "ar-MA" : "fr-MA", { numeric: "always" });
  if (seconds >= 3600) return formatter.format(Math.ceil(seconds / 3600), "hour");
  if (seconds >= 60) return formatter.format(Math.ceil(seconds / 60), "minute");
  return formatter.format(Math.max(1, Math.ceil(seconds)), "second");
}

const WITH_WAIT: readonly ApiErrorCode[] = ["rate_limited", "account_locked"];

/** Reasons of a 400 `weak_password` (src/lib/auth/password-rules.ts) that have their own message. */
const WEAK_PASSWORD_REASONS = ["common", "personal", "repeated", "sequence"] as const;
type WeakPasswordReason = (typeof WEAK_PASSWORD_REASONS)[number];

function weakPasswordReason(error: ApiError): WeakPasswordReason | null {
  const reason = typeof error.details === "object" && error.details !== null ? (error.details as { reason?: unknown }).reason : undefined;
  return typeof reason === "string" && (WEAK_PASSWORD_REASONS as readonly string[]).includes(reason) ? (reason as WeakPasswordReason) : null;
}

export function useApiErrorMessage(): (error: unknown) => string {
  const t = useTranslations("Auth.errors");
  const common = useTranslations("Auth.common");
  const locale = useLocale();
  return useCallback(
    (error: unknown) => {
      const code: ApiErrorCode = error instanceof ApiError ? error.code : "internal";
      if (code === "rate_limited" || code === "account_locked") {
        return t(code, { wait: formatWait(locale, error instanceof ApiError ? error.retryAfter : undefined, common("waitLater")) });
      }
      if (code === "weak_password" && error instanceof ApiError) {
        const reason = weakPasswordReason(error);
        if (reason) return t(`weak_password_${reason}`);
      }
      return t.has(code) && !WITH_WAIT.includes(code) ? t(code) : t("internal");
    },
    [t, common, locale],
  );
}

type FieldKind = "email" | "password" | "newPassword" | "displayName" | "consent" | "currentPassword" | "phone" | "locale";

/** The message of a field error: the server's own text when set with `setError`, else by field and issue. */
export function useFieldMessage(): (kind: FieldKind, error?: FieldError) => string | undefined {
  const t = useTranslations("Auth.common.validation");
  return useCallback(
    (kind, error) => {
      if (!error) return undefined;
      if (error.type === "server" && error.message) return error.message;
      switch (kind) {
        case "email":
          return t("email");
        case "password":
          return t("passwordRequired");
        case "newPassword":
          return error.type === "too_big" ? t("passwordMax", { max: PASSWORD_MAX }) : t("passwordMin", { min: PASSWORD_MIN });
        case "displayName":
          return error.type === "too_small" ? t("displayNameMin") : error.type === "too_big" ? t("displayNameMax") : t("displayNameFormat");
        case "consent":
          return t("consentRequired");
        case "currentPassword":
          return t("currentPassword");
        case "phone":
          return t("phone");
        case "locale":
          return t("locale");
      }
    },
    [t],
  );
}

interface FormMessageProps {
  /** An ApiError (or anything thrown): nothing renders when undefined. */
  error?: unknown;
  tone?: "danger" | "warning" | "info";
  /** Overrides the translated code. */
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Form-level message; focus moves to it when it appears, so screen readers and keyboards land on the explanation. */
export function FormMessage({ error, tone = "danger", title, children, action, className }: FormMessageProps) {
  const message = useApiErrorMessage();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) box.current?.focus({ preventScroll: false });
  }, [error]);
  if (!error) return null;
  return (
    <div ref={box} tabIndex={-1} className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/25">
      <ErrorBanner tone={tone} title={title ?? message(error)} action={action} className={className}>
        {children}
      </ErrorBanner>
    </div>
  );
}
