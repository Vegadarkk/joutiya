"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "./empty-state";

/** Body of the segment error boundaries: what happened, then retry or leave. */
export function ErrorView({ retry }: { retry: () => void }) {
  const t = useTranslations("Error");
  return (
    <EmptyState
      headingLevel="h1"
      title={t("title")}
      action={
        <>
          <Button onClick={() => retry()}>{t("retry")}</Button>
          <Button asChild variant="outline">
            <Link href="/">{t("back")}</Link>
          </Button>
        </>
      }
    >
      {t("body")}
    </EmptyState>
  );
}
