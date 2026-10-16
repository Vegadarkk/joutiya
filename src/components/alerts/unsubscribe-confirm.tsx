"use client";

import { useState } from "react";
import { BellOff, CheckCircle2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormMessage } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { apiPost } from "@/lib/auth/client";
import { SEARCH_API } from "@/lib/contracts/search";

// The confirm button of /alertes/desabonnement (design D20): the page itself never changes
// anything (a mail scanner or a prefetch may open it); this POST with the token does.

export function UnsubscribeConfirm({ token, scope }: { token: string; scope: "one" | "all" }) {
  const t = useTranslations("Alerts.unsubscribe");
  const [state, setState] = useState<{ kind: "idle" | "pending" | "done" } | { kind: "failed"; error: unknown }>({ kind: "idle" });

  async function confirm() {
    setState({ kind: "pending" });
    try {
      await apiPost<void>(SEARCH_API.unsubscribe, { token });
      setState({ kind: "done" });
    } catch (error) {
      setState({ kind: "failed", error });
    }
  }

  if (state.kind === "done") {
    return (
      <div role="status" className="flex flex-col items-center gap-4" data-testid="unsubscribe-done">
        <p className="inline-flex items-center gap-2 font-medium text-success">
          <CheckCircle2 className="size-5" aria-hidden="true" />
          {scope === "all" ? t("doneAll") : t("doneOne")}
        </p>
        <p className="text-foreground-muted text-pretty">{t("doneBody")}</p>
        <Button asChild variant="outline">
          <Link href="/recherches">{t("manage")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-center gap-4">
      {state.kind === "failed" ? <FormMessage error={state.error} className="w-full text-start" /> : null}
      <div className="flex flex-col-reverse items-stretch gap-2 sm:flex-row sm:justify-center">
        <Button asChild variant="outline">
          <Link href="/recherches">{t("manage")}</Link>
        </Button>
        <Button type="button" loading={state.kind === "pending"} onClick={() => void confirm()} data-testid="unsubscribe-confirm">
          <BellOff aria-hidden="true" />
          {t("confirm")}
        </Button>
      </div>
    </div>
  );
}
