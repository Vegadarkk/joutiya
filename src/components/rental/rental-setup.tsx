"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CircleCheck, CircleDashed } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import type { ProSelfView } from "@/lib/contracts/pro";
import { loadFleet } from "@/lib/listings/client/api";
import { isFresh } from "@/lib/listings/rental-availability";
import { cn } from "@/lib/utils";

// Start-up checklist of a car rental agency in its Pro area (rental pack §5): settings with the
// licence reference, a first vehicle on offer (or the fleet imported), then an up-to-date
// planning. Reads the fleet once (GET /api/pro/fleet); a failed read leaves steps 2 and 3 open.

type Fleet = { vehicles: number; fresh: boolean } | null;

export function RentalSetup({ shop }: { shop: Pick<ProSelfView, "rental"> }) {
  const t = useTranslations("RentalAgency.setup");
  const [fleet, setFleet] = useState<Fleet>(null);

  useEffect(() => {
    let live = true;
    loadFleet()
      .then((response) => {
        const now = Date.now();
        if (live)
          setFleet({
            vehicles: response.vehicles.length,
            fresh: response.vehicles.length > 0 && response.vehicles.every((vehicle) => isFresh(vehicle.rental?.updatedAt ? new Date(vehicle.rental.updatedAt) : null, now)),
          });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const steps = [Boolean(shop.rental?.agrementRef), (fleet?.vehicles ?? 0) > 0, fleet?.fresh === true];
  const done = steps.filter(Boolean).length;

  return (
    <section aria-labelledby="rental-setup" data-testid="rental-setup" className="flex flex-col gap-5 rounded-lg border border-border bg-surface-brand p-5 sm:p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex flex-col gap-1">
          <h2 id="rental-setup" className="text-lg font-semibold">
            {done === steps.length ? t("readyTitle") : t("title")}
          </h2>
          <p className="max-w-prose text-sm text-foreground-muted text-pretty">{done === steps.length ? t("ready") : t("lead")}</p>
        </div>
        <p className="text-sm font-medium tabular-nums" data-testid="rental-setup-progress">
          {t("progress", { done, total: steps.length })}
        </p>
      </header>
      <ol className="grid gap-3 md:grid-cols-3">
        <Step done={steps[0]!} index={1} title={t("step1")} hint={t("step1Hint")}>
          <Button asChild size="sm" variant={steps[0] ? "outline" : "primary"}>
            <Link href="/pro/location">{t("step1Action")}</Link>
          </Button>
        </Step>
        <Step done={steps[1]!} index={2} title={t("step2")} hint={t("step2Hint")}>
          <Button asChild size="sm" variant={steps[0] && !steps[1] ? "primary" : "outline"}>
            <Link href="/deposer">{t("step2Action")}</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/pro/stock">{t("step2Import")}</Link>
          </Button>
        </Step>
        <Step done={steps[2]!} index={3} title={t("step3")} hint={t("step3Hint")}>
          <Button asChild size="sm" variant={steps[1] && !steps[2] ? "primary" : "outline"}>
            <Link href="/pro/flotte">{t("step3Action")}</Link>
          </Button>
        </Step>
      </ol>
    </section>
  );
}

function Step({ done, index, title, hint, children }: { done: boolean; index: number; title: string; hint: string; children: ReactNode }) {
  const t = useTranslations("RentalAgency.setup");
  const Icon = done ? CircleCheck : CircleDashed;
  return (
    <li data-testid="rental-setup-step" data-done={done ? "" : undefined} className={cn("flex flex-col gap-3 rounded-md border bg-surface p-4", done ? "border-success/40" : "border-border")}>
      <div className="flex items-start gap-2.5">
        <Icon className={cn("mt-0.5 size-5 shrink-0", done ? "text-success" : "text-foreground-muted")} aria-hidden="true" />
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold">
            <span className="sr-only">{done ? t("doneLabel", { index }) : t("todoLabel", { index })} </span>
            {title}
          </h3>
          <p className="text-sm text-foreground-muted text-pretty">{hint}</p>
        </div>
      </div>
      <div className="mt-auto flex flex-wrap gap-2">{children}</div>
    </li>
  );
}
