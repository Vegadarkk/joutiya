import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { AccountMenu } from "@/components/auth/account-menu";
import { DoorMark } from "@/components/feedback/door-mark";
import { CATEGORIES } from "@/config/categories";
import { SITE_NAME } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { CategoryChips } from "./category-chips";
import { Container } from "./container";
import { HeaderSearch } from "./header-search";
import { IntentLink } from "./intent-link";
import { LocaleSwitcher } from "./locale-switcher";
import { Logo } from "./logo";
import { ProEntry } from "./pro-entry";
import { RentEntry } from "./rent-entry";
import { SellFab } from "./sell-fab";
import { AssistantBubble } from "@/components/help/assistant-bubble";

// Header of the Carte vivante (lot 1): separate floating pieces on the page ground, never one solid
// band, so that the map pages of the next lots can lay the same pieces over the map. One sticky row
// (64 px, 80 px from md: the messages shell sizes itself on these heights): the logo plate, the
// search pill, the pill of account buttons and the "Vendre" arch. The category row scrolls away
// under it; on phones "Vendre" floats at the bottom end. Every control is a 44 px touch target.
// The search pill hides on pages whose main content has its own search form (the help centre):
// never two search fields at once. On /recherche the pill is the page's search (lot 2), filled
// from the URL, and over the map view the band turns clear so that its pieces float on the map.
// Owner's choice B (29 Oct 2026): "Louer" (menu of the two rental searches) and "Espace Pro" stand
// between the account pill and "Vendre" from lg, compact until xl; below lg they live in the account
// menus. The header and its category row run to max-w-7xl, 88rem from xl, wider than the page's
// max-w-6xl, so the search pill keeps its room beside the six pieces (its place segment waits for xl).

export function SiteHeader({ locale }: { locale: string }) {
  const t = useTranslations("Nav");
  const names = useTranslations("Categories");
  type CategoryKey = Parameters<typeof names>[0];
  const chips = CATEGORIES.map((category) => ({ id: category.id, label: names(`${category.id}.name` as CategoryKey) }));
  return (
    <>
      {/* Over the search map (lot 2) the band goes clear: only its pieces float, the map takes the rest. */}
      <header className="header-lift sticky top-0 z-40 bg-background/85 backdrop-blur-md search-map:pointer-events-none search-map:bg-transparent search-map:backdrop-blur-none search-map:[animation:none]">
        <Container className="flex h-16 max-w-7xl items-center gap-2 md:h-20 md:gap-3 lg:gap-4 xl:max-w-[88rem] search-map:*:pointer-events-auto search-map:lg:max-w-none">
          {/* On every page: the home payload is prefetched when the visitor reaches for the logo, not during load. */}
          <IntentLink
            href="/"
            aria-label={t("home")}
            className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-surface-brand shadow-[0_0_0_1px_var(--float-edge),0_8px_20px_-10px_var(--float-shadow)] md:size-auto md:h-13 md:rounded-[0.7rem] md:bg-transparent md:dark:bg-surface md:dark:px-3.5 search-map:md:bg-surface search-map:md:px-3.5"
          >
            <DoorMark className="w-6 md:hidden" />
            <Logo label={SITE_NAME} className="hidden h-full md:inline-flex dark:h-9" />
          </IntentLink>

          <HeaderSearch locale={locale} className="flex-1 md:mx-auto md:max-w-2xl [:root:has(#main_[role=search])_&]:hidden" />

          <div className="ms-auto flex shrink-0 items-center gap-3 md:gap-4">
            <div className="float-card flex h-12 items-center gap-0.5 rounded-full p-0.5 md:h-13 md:p-1" data-testid="header-actions">
              {/* Anonymous first on every page (public pages are static); swaps after /api/auth/me. */}
              <AccountMenu />
              {/* Phones reach the languages from the footer. */}
              <LocaleSwitcher className="hidden rounded-full px-3 md:inline-flex" />
            </div>
            <RentEntry />
            <ProEntry />
            <Link href="/deposer" className="sell-arch hidden h-13 items-center gap-1.5 ps-4 pe-5 font-semibold transition-[background-color,scale] duration-150 ease-door hover:bg-ochre-700 active:scale-[0.98] md:inline-flex">
              <Plus className="size-5" strokeWidth={2.25} aria-hidden="true" />
              {t("sell")}
              <span className="sr-only">, {t("post")}</span>
            </Link>
          </div>
        </Container>
      </header>
      <CategoryChips items={chips} label={t("categories")} shops={t("shops")} guide={t("guide")} previous={t("previousCategories")} next={t("nextCategories")} />
      <SellFab label={t("post")} text={t("sell")} />
      <AssistantBubble />
    </>
  );
}
