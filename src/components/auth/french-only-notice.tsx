import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * Tarifit interface: the account and sign-in pages stay entirely in French until a native speaker
 * has reviewed their translation (messages/rif.json carries no Auth key on purpose: a partial
 * translation mixed two languages word by word). Same voice as the legal pages' "frenchPrevails".
 */
export function FrenchOnlyNotice({ className }: { className?: string }) {
  const locale = useLocale();
  const t = useTranslations("Auth.common");
  if (locale !== "rif") return null;
  return (
    <aside lang="fr" className={cn("border-s-4 border-featured bg-surface-muted px-4 py-3 text-sm text-foreground-muted", className)}>
      {t("frenchOnly")}
    </aside>
  );
}
