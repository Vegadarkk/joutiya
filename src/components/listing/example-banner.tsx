import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

// Example listing (owner decision of 2026-10-28, src/lib/demo): a listing Joutiya wrote to show what
// a good listing of its kind looks like. The page says so above the gallery and in place of the
// contact actions, which the API refuses too (acceptsContact).

export function ExampleBanner({ className }: { className?: string }) {
  const t = useTranslations("ListingPage.example");
  return (
    <div
      role="note"
      data-testid="example-banner"
      className={cn("flex flex-col gap-3 rounded-lg border border-featured/70 bg-gold-100/60 p-4 text-foreground dark:bg-surface sm:flex-row sm:items-center sm:justify-between", className)}
    >
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 size-5 shrink-0 text-gold-700 dark:text-gold-300" aria-hidden="true" />
        <div className="flex flex-col gap-0.5">
          <p className="font-semibold">{t("title")}</p>
          <p className="text-sm text-foreground-muted text-pretty">{t("body")}</p>
        </div>
      </div>
      <Button asChild variant="outline" className="self-start sm:self-center">
        <Link href="/deposer">{t("cta")}</Link>
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
