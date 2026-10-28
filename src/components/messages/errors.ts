"use client";

import { useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatWait, useApiErrorMessage } from "@/components/auth/form-message";
import { ApiError } from "@/lib/auth/client";

// Refusals of the messaging API (design phase-5 D4-D9) in the messaging pages' words; the codes
// shared with every form (blocked, frozen, network...) keep the generic Auth.errors wording.

export const MESSAGING_ERROR_KEYS = ["rate_limited", "quota_exhausted", "account_suspended", "not_found", "listing_unavailable", "invalid_body"] as const;
export type MessagingErrorKey = (typeof MESSAGING_ERROR_KEYS)[number];

export function messagingErrorKey(error: unknown): MessagingErrorKey | null {
  const code = error instanceof ApiError ? error.code : null;
  return code && (MESSAGING_ERROR_KEYS as readonly string[]).includes(code) ? (code as MessagingErrorKey) : null;
}

export function useMessagingErrorMessage(): (error: unknown) => string {
  const t = useTranslations("Messaging.errors");
  const generic = useApiErrorMessage();
  const locale = useLocale();
  return useCallback(
    (error: unknown) => {
      const key = messagingErrorKey(error);
      if (key === "rate_limited") return t("rate_limited", { wait: formatWait(locale, error instanceof ApiError ? error.retryAfter : undefined, t("later")) });
      return key ? t(key) : generic(error);
    },
    [t, generic, locale],
  );
}
