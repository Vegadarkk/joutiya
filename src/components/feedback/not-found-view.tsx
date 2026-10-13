import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "./empty-state";

export function NotFoundView() {
  const t = useTranslations("NotFound");
  return (
    <EmptyState
      headingLevel="h1"
      title={t("title")}
      action={
        <Button asChild>
          <Link href="/">{t("back")}</Link>
        </Button>
      }
    >
      {t("body")}
    </EmptyState>
  );
}
