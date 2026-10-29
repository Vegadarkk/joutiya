"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { useMessagingErrorMessage } from "@/components/messages/errors";
import { ApiError } from "@/lib/auth/client";
import { offerErrorKey } from "./error-keys";

export { OFFER_ERROR_KEYS, offerErrorKey, type OfferErrorKey } from "./error-keys";

// Refusals of an offer step in words (Carte vivante lot 5); the rest like any messaging refusal.

export function useOfferErrorMessage(): (error: unknown) => string {
  const t = useTranslations("Offers.errors");
  const messaging = useMessagingErrorMessage();
  return useCallback(
    (error: unknown) => {
      const key = offerErrorKey(error);
      if (key) return t(key);
      // An amount out of bounds the dialog did not catch (the price changed meanwhile).
      if (error instanceof ApiError && error.code === "invalid_body") return t("amount");
      return messaging(error);
    },
    [t, messaging],
  );
}
