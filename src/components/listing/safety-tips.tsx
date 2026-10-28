import { HandCoins, ShieldAlert, Store, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { textLinkClassName } from "@/components/ui/text-link";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

// Safety advice of the listing page (§10 "conseils de sécurité") and the neutral-host statement:
// Joutiya hosts the listing and is party to no transaction (LCEN art. 6 / DSA art. 6 hosting).

const TIPS = [
  { key: "noAdvance", icon: HandCoins },
  { key: "meetPublic", icon: Users },
  { key: "checkItem", icon: Store },
  { key: "noCodes", icon: ShieldAlert },
] as const;

export function SafetyTips({ className }: { className?: string }) {
  const t = useTranslations("ListingPage.safety");
  return (
    <section data-testid="safety-tips" aria-labelledby="safety-title" className={cn("flex flex-col gap-4 rounded-lg bg-surface-brand p-5", className)}>
      <h2 id="safety-title" className="text-lg font-semibold">
        {t("title")}
      </h2>
      <ul className="flex flex-col gap-3">
        {TIPS.map(({ key, icon: Icon }) => (
          <li key={key} className="flex items-start gap-3 text-sm text-pretty">
            <Icon className="mt-0.5 size-4 shrink-0 text-structure dark:text-gold-300" aria-hidden="true" />
            <span>{t(`tips.${key}`)}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-foreground-muted text-pretty">{t("host")}</p>
      <Link href="/legal/confiance-et-securite" className={cn("-my-2 inline-flex min-h-11 items-center self-start rounded-sm text-sm font-medium text-link", textLinkClassName)}>
        {t("more")}
      </Link>
    </section>
  );
}
