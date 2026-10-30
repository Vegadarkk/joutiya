import { CarFront, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { RENT_CAR_SEARCH } from "@/lib/search/shortcuts";
import { cn } from "@/lib/utils";

// "Louer une voiture" in the home map's panel (Carte vivante, lot 3): the rental module's promise
// as one card linking to the car rental search, where the city and the dates are chosen (the search
// page's dates bar; src/lib/search/shortcuts.ts). The full form stays on the list view of the home
// page (RentCarModule).

export function RentCarLink({ className }: { className?: string }) {
  const t = useTranslations("Rental.home");
  return (
    <section
      aria-labelledby="home-rent-car-link"
      data-testid="home-rent-car-link"
      className={cn(
        "group/rent relative flex items-center gap-3 rounded-xl border border-border bg-surface-brand p-3 transition-[border-color] duration-150 ease-door hover:border-border-strong",
        "has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ring",
        className,
      )}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-structure text-structure-foreground">
        <CarFront aria-hidden="true" className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id="home-rent-car-link" className="text-sm font-semibold">
          <Link href={RENT_CAR_SEARCH} prefetch={false} className="outline-none after:absolute after:inset-0 after:rounded-xl">
            {t("title")}
          </Link>
        </h2>
        <p className="text-xs text-foreground-muted text-pretty">{t("open")}</p>
      </div>
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-foreground-muted transition-transform duration-150 ease-door group-hover/rent:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover/rent:-translate-x-0.5" />
    </section>
  );
}
