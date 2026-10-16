"use client";

import { useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { LOCALES, type Locale } from "@/config/site";
import { useRouter } from "@/i18n/navigation";
import { safeNextPath } from "@/lib/auth/client";

const LOCALE_PREFIX = new RegExp(`^/(${LOCALES.join("|")})(?=/|\\?|#|$)`);

/**
 * Where to go once signed in: the `?next=` path when it is a same-origin relative path (set by
 * the account layout guard), else the settings page. A locale prefix in `next` is honoured.
 */
export function useAfterSignIn(): () => void {
  const router = useRouter();
  const params = useSearchParams();
  return useCallback(() => {
    const next = safeNextPath(params.get("next"));
    if (!next) {
      router.replace("/parametres");
      return;
    }
    const prefixed = LOCALE_PREFIX.exec(next);
    if (prefixed) {
      router.replace(next.slice(prefixed[0].length) || "/", { locale: prefixed[1] as Locale });
    } else {
      router.replace(next);
    }
  }, [router, params]);
}
