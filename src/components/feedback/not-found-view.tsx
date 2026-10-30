import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { CATEGORIES } from "@/config/categories";
import { EmptyState } from "./empty-state";

/** The first four categories: a dead link should not be a dead end (UX audit, finding 20). */
const SHORTCUTS = CATEGORIES.slice(0, 4);

export function NotFoundView() {
  const t = useTranslations("NotFound");
  const names = useTranslations("Categories");
  type CategoryKey = Parameters<typeof names>[0];
  return (
    <EmptyState
      headingLevel="h1"
      title={t("title")}
      action={
        <>
          <Button asChild>
            <Link href="/">{t("back")}</Link>
          </Button>
          <nav aria-label={t("browse")} className="flex w-full flex-col items-center gap-3 pt-2">
            <span className="text-sm text-foreground-muted">{t("browse")}</span>
            <ul className="flex flex-wrap justify-center gap-2">
              {SHORTCUTS.map((category) => (
                <li key={category.id}>
                  <Link
                    href={`/c/${category.id}`}
                    prefetch={false}
                    className="float-card flex h-9 items-center rounded-full px-4 text-sm font-medium text-foreground transition-[background-color] duration-150 ease-door hover:bg-surface-muted"
                  >
                    {names(`${category.id}.name` as CategoryKey)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </>
      }
    >
      {t("body")}
    </EmptyState>
  );
}
