import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { HideExamplesButton } from "@/components/examples/examples-controls";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

// Example listing or shop (owner decision of 2026-10-28, src/lib/demo): written by Joutiya to show
// what a good listing or a Pro storefront looks like. The page says so, and the contact actions are
// gone (the API refuses them too: acceptsContact). On an example shop, `data-example-page` keeps its
// own listings in view when the visitor hides the examples (globals.css): they asked for this shop.

export function ExampleBanner({ scope = "listing", className }: { scope?: "listing" | "shop"; className?: string }) {
  const listing = useTranslations("ListingPage.example");
  const shop = useTranslations("Storefront.example");
  const t = (key: "title" | "body" | "cta") => (scope === "shop" ? shop(key) : listing(key));
  return (
    <div
      role="note"
      data-testid="example-banner"
      data-example-page={scope === "shop" ? "" : undefined}
      className={cn("flex flex-col gap-3 rounded-lg border border-featured/70 bg-gold-100/60 p-4 text-foreground dark:bg-surface sm:flex-row sm:items-center sm:justify-between", className)}
    >
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 size-5 shrink-0 text-gold-700 dark:text-gold-300" aria-hidden="true" />
        <div className="flex flex-col gap-0.5">
          <p className="font-semibold">{t("title")}</p>
          <p className="text-sm text-foreground-muted text-pretty">{t("body")}</p>
          <HideExamplesButton className="-ms-3 mt-1" />
        </div>
      </div>
      <Button asChild variant="outline" className="self-start sm:self-center">
        <Link href={scope === "shop" ? "/pro" : "/deposer"}>{t("cta")}</Link>
      </Button>
    </div>
  );
}

export function ExampleContactNotice() {
  const t = useTranslations("ListingPage.example");
  return (
    <p data-testid="example-contact" className="rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-foreground-muted text-pretty">
      {t("contact")}
    </p>
  );
}
