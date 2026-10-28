"use client";

import { useState } from "react";
import { ScrollText } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/layout/container";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { numbersLocale } from "@/i18n/params";
import { apiPost, setSession, useSession } from "@/lib/auth/client";
import type { ConsentsResponse } from "@/lib/contracts/auth";
import { AUTH_API } from "@/lib/contracts/endpoints";

// CGU change notice (phase 6, D11; DSA art. 14 § 2): a signed-in member who accepted an earlier
// version sees this band under the header, on every page, until they acknowledge the new text.
// Acknowledging records the current version (POST /api/auth/consents { cgu: true }, journaled).

/** Today's date in Casablanca, as the ISO day of LEGAL_VERSIONS. */
function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Casablanca" }).format(new Date());
}

export function CguNotice() {
  const t = useTranslations("CguNotice");
  const locale = useLocale() as Locale;
  const { status, session } = useSession();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const update = status === "ready" ? session?.cguUpdate : null;
  if (!session || !update) return null;

  const date = new Intl.DateTimeFormat(numbersLocale(locale), { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${update.effective}T00:00:00Z`));

  async function acknowledge() {
    if (!session) return;
    setBusy(true);
    setFailed(false);
    try {
      await apiPost<ConsentsResponse>(AUTH_API.consents, { cgu: true });
      setSession({ ...session, cguUpdate: null });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="cgu-notice-title" className="border-b border-border bg-surface-brand" data-testid="cgu-notice">
      <Container className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <ScrollText className="mt-0.5 size-5 shrink-0 text-structure dark:text-gold-300" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id="cgu-notice-title" className="text-sm font-semibold text-balance">
              {t(update.effective > today() ? "titleUpcoming" : "titleChanged", { date })}
            </h2>
            <p className="text-sm text-foreground-muted text-pretty">{t("body")}</p>
            {failed ? (
              <p role="alert" className="text-sm text-danger">
                {t("failed")}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 ps-8 sm:ps-0">
          <Button asChild variant="outline" size="sm">
            <Link href="/legal/cgu">{t("read")}</Link>
          </Button>
          <Button type="button" size="sm" loading={busy} onClick={() => void acknowledge()}>
            {t("acknowledge")}
          </Button>
        </div>
      </Container>
    </section>
  );
}
