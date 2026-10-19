"use client";

import { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { fetchMyDecisions } from "@/lib/decisions/client";
import type { AppealableDecision } from "@/lib/decisions/contracts";
import { visibleDecisions } from "./appeal-state";
import { DecisionCard } from "./decision-card";

// /recours (account): the moderation decisions about my account and contents, newest first, each
// with its statement of reasons and its appeal (art. 17 and 20 DSA, design D16). Read from
// GET /api/appeals; a suspended account reads it too.

type State = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; items: AppealableDecision[] };

export function DecisionsView() {
  const t = useTranslations("Appeals.page");
  const [state, setState] = useState<State>({ kind: "loading" });

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    fetchMyDecisions().then(
      ({ items }) => live && setState({ kind: "ready", items: visibleDecisions(items) }),
      () => live && setState({ kind: "failed" }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  function retry() {
    setState({ kind: "loading" });
    setAttempt((count) => count + 1);
  }

  if (state.kind === "loading") {
    return (
      <div role="status" aria-label={t("loading")} className="flex flex-col gap-4" data-testid="decisions-loading">
        {[0, 1].map((key) => (
          <div key={key} className="flex flex-col gap-3 rounded-lg border border-s-4 border-border p-5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-16 w-full" />
          </div>
        ))}
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <ErrorBanner
        title={t("loadFailed")}
        action={
          <Button type="button" variant="outline" size="sm" className="max-sm:h-11" onClick={retry}>
            <RotateCw aria-hidden="true" />
            {t("retry")}
          </Button>
        }
      />
    );
  }
  if (state.items.length === 0) {
    return (
      <EmptyState
        title={t("emptyTitle")}
        action={
          <Button asChild variant="outline">
            <Link href="/mes-annonces">{t("emptyAction")}</Link>
          </Button>
        }
      >
        {t("emptyBody")}
      </EmptyState>
    );
  }
  return (
    <ul className="flex flex-col gap-5" data-testid="decisions-list">
      {state.items.map((decision) => (
        <li key={decision.decisionId}>
          <DecisionCard decision={decision} mode={{ kind: "member" }} />
        </li>
      ))}
    </ul>
  );
}
