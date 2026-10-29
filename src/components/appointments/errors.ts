"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { useMessagingErrorMessage } from "@/components/messages/errors";
import { ApiError } from "@/lib/auth/client";

// Refusals of the appointment route: its own codes (a place with payment details, A-02), then the messaging wording (blocked,
// frozen, rate limited, quota...).

const APPOINTMENT_ERROR_KEYS = ["appointment_changed", "appointment_slot_past", "place_payment_details"] as const;

export function useAppointmentErrorMessage(): (error: unknown) => string {
  const t = useTranslations("Appointments.errors");
  const messaging = useMessagingErrorMessage();
  return useCallback(
    (error: unknown) => {
      const code = error instanceof ApiError ? error.code : null;
      const key = APPOINTMENT_ERROR_KEYS.find((item) => item === code);
      return key ? t(key) : messaging(error);
    },
    [t, messaging],
  );
}
