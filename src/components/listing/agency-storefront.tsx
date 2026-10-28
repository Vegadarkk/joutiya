import { ArrowRight, House, KeyRound, ReceiptText, TreePalm, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { categoryById } from "@/config/categories";
import { Link } from "@/i18n/navigation";
import { searchPath } from "@/lib/search/params";
import { cn } from "@/lib/utils";

// Blocks of a real-estate agency's storefront (Agence pack design §3): the agency's listings per
// transaction, each a link to the search narrowed to the shop, and its fee schedule as the agency
// wrote it. Server-rendered; the counts come from the engine (none shown when it is down).

const CATEGORY = "immobilier";

const ICONS: Record<string, ReactNode> = {
  vente: <House className="size-5" aria-hidden="true" />,
  location: <KeyRound className="size-5" aria-hidden="true" />,
  colocation: <Users className="size-5" aria-hidden="true" />,
  "location-vacances": <TreePalm className="size-5" aria-hidden="true" />,
};

export function AgencyTransactions({ counts, shopPublicId, className }: { counts: Record<string, number>; shopPublicId: string; className?: string }) {
  const t = useTranslations("Storefront.agency");
  const names = useTranslations("Categories");
  const tiles = (categoryById(CATEGORY)?.subcategories ?? []).filter((sub) => (counts[sub.id] ?? 0) > 0);
  if (tiles.length === 0) return null;
  return (
    <section aria-labelledby="agency-transactions" data-testid="agency-transactions" className={cn("flex flex-col gap-4", className)}>
      <h2 id="agency-transactions" className="text-xl font-semibold">
        {t("transactionsTitle")}
      </h2>
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((sub) => (
          <li key={sub.id} className="min-w-0">
            <Link
              href={searchPath({ category: CATEGORY, subcategory: sub.id, shop: shopPublicId })}
              className="group flex h-full flex-col gap-3 rounded-lg border border-border bg-surface p-4 transition-colors duration-150 hover:border-structure dark:hover:border-gold-300"
            >
              <span className="flex size-10 items-center justify-center rounded-full bg-structure/10 text-structure dark:bg-gold-300/15 dark:text-gold-300">{ICONS[sub.id]}</span>
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{names(`${CATEGORY}.sub.${sub.id}` as Parameters<typeof names>[0])}</span>
                <span className="text-sm text-foreground-muted tabular-nums">{t("count", { count: counts[sub.id] ?? 0 })}</span>
              </span>
              <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-link">
                {t("see")}
                <ArrowRight className="size-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" aria-hidden="true" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The agency's fee schedule as it wrote it (law 31-08 art. 3: prices shown to consumers). */
export function FeeSchedule({ text, className }: { text: string; className?: string }) {
  const t = useTranslations("Storefront.agency");
  if (!text.trim()) return null;
  return (
    <section aria-labelledby="agency-fees" data-testid="agency-fees" className={cn("flex flex-col gap-3 rounded-lg border border-border bg-surface p-5", className)}>
      <h2 id="agency-fees" className="flex items-center gap-2 text-base font-semibold">
        <ReceiptText className="size-5 shrink-0 text-gold-500 dark:text-gold-300" aria-hidden="true" />
        {t("feesTitle")}
      </h2>
      <p dir="auto" className="leading-relaxed whitespace-pre-line text-pretty">
        {text}
      </p>
      <p className="text-xs text-foreground-muted text-pretty">{t("feesNote")}</p>
    </section>
  );
}
