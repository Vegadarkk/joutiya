"use client";

import { useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { afterSignInTarget } from "@/lib/auth/next-path";
import { welcomeAfterSignIn } from "@/lib/welcome/flags";

/**
 * Where to go once signed in: the `?next=` path when it is a same-origin relative path (set by
 * the account layout guard and the header link), else the settings page. A locale prefix in
 * `next` is honoured. Same check as the sign-in pages' server-side redirect.
 * The device then never gets the welcome screen, and the door opens on the home page when that is
 * where the sign-in lands, once per device.
 */
export function useAfterSignIn(): () => void {
  const router = useRouter();
  const params = useSearchParams();
  return useCallback(() => {
    const target = afterSignInTarget(params.get("next"));
    welcomeAfterSignIn(target.pathname);
    router.replace(target.pathname, target.locale ? { locale: target.locale } : undefined);
  }, [router, params]);
}
