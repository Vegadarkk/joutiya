"use client";

import { useTransition } from "react";
import { CloudOff, Timer } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { formatWait } from "@/components/auth/form-message";
import { Button } from "@/components/ui/button";
import { Link, useRouter } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { useSearchNavigation } from "./search-navigation";

// Search failed (design D2): the engine is down (honest failure, no Firestore fallback) or this
// visitor went past the limits with a challenge pass (429). The criteria stay in the URL: "Réessayer"
// renders the same search again.

interface SearchErrorProps {
  kind: "unavailable" | "rate_limited";
  /** Seconds, from Retry-After (rate_limited). */
  retryAfter?: number;
  className?: string;
}

export function SearchError({ kind, retryAfter, className }: SearchErrorProps) {
  const t = useTranslations("SearchPage");
  const locale = useLocale();
  const router = useRouter();
  const navigation = useSearchNavigation();
  const [pending, startTransition] = useTransition();
  const busy = pending || (navigation?.pending ?? false);
  const Icon = kind === "rate_limited" ? Timer : CloudOff;

  function retry() {
    if (navigation) navigation.refresh();
    else startTransition(() => router.refresh());
  }

  return (
    <section data-testid="search-error" data-kind={kind} role="alert" className={cn("mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-14 text-center", className)}>
      <span className="flex size-14 items-center justify-center rounded-full bg-surface-brand text-structure dark:text-gold-300">
        <Icon className="size-6" aria-hidden="true" strokeWidth={1.75} />
      </span>
      <h2 className="text-xl font-semibold text-balance">{kind === "rate_limited" ? t("rateLimited.title") : t("error.title")}</h2>
      <p className="text-foreground-muted text-pretty">
        {kind === "rate_limited" ? t("rateLimited.body", { wait: formatWait(locale, retryAfter, t("rateLimited.later")) }) : t("error.body")}
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-3">
        <Button type="button" onClick={retry} loading={busy}>
          {t("error.retry")}
        </Button>
        <Button asChild variant="outline">
          <Link href="/">{t("error.home")}</Link>
        </Button>
      </div>
    </section>
  );
}
