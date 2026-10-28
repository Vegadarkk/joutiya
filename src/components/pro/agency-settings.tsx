"use client";

import { useId, useState, type FormEvent } from "react";
import { Building2, CarFront, Store } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FormMessage } from "@/components/auth/form-message";
import { Textarea } from "@/components/post/controls/textarea";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import type { ProSelfView } from "@/lib/contracts/pro";
import { firstStrictIssue } from "@/lib/moderation/free-text";
import { saveProAgency } from "@/lib/pro/client";
import { AGENCY_FEE_SCHEDULE_MAX, PRO_SECTORS, type ProSector } from "@/lib/pro/profile-schema";
import { cn } from "@/lib/utils";

// The shop's sector in the Pro area (Agence pack design §3): a real-estate agency gets an agency
// storefront (listings per transaction, fee schedule) and the mandate and fees on its listings; a
// car rental agency its fleet storefront (rental pack §5), set up from /pro/location.
// The fee schedule follows the storefront text screen (free-text.ts), live here and again on the server.

const ICONS = { general: Store, real_estate: Building2, car_rental: CarFront } as const;

export function AgencySettings({ shop }: { shop: Pick<ProSelfView, "sector" | "feeSchedule"> }) {
  const t = useTranslations("Pro.agency");
  const issues = useTranslations("FreeText");
  const name = useId();
  const [saved, setSaved] = useState({ sector: shop.sector, feeSchedule: shop.feeSchedule });
  const [sector, setSector] = useState<ProSector>(shop.sector);
  const [feeSchedule, setFeeSchedule] = useState(shop.feeSchedule);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const agency = sector === "real_estate";
  const dirty = sector !== saved.sector || (agency && feeSchedule.trim() !== saved.feeSchedule);
  const trimmed = feeSchedule.trim();
  // The server screen, run as the agency types: no contact detail, prohibited term or sensitive data.
  const issue = agency && trimmed ? firstStrictIssue(trimmed) : null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !dirty || issue) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await saveProAgency({ sector, feeSchedule: agency ? trimmed : "" });
      setSaved(result);
      setFeeSchedule(result.feeSchedule || feeSchedule);
      toast.success(t("saved"));
    } catch (caught) {
      setFailure(caught);
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="pro-agency" data-testid="agency-settings" className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5">
      <header className="flex flex-col gap-1">
        <h2 id="pro-agency" className="text-lg font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-foreground-muted text-pretty">{t("lead")}</p>
      </header>
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-5">
        <fieldset className="grid gap-2 md:grid-cols-3">
          <legend className="sr-only">{t("title")}</legend>
          {PRO_SECTORS.map((value) => {
            const Icon = ICONS[value];
            return (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border bg-surface p-3.5 transition-colors duration-150",
                  sector === value ? "border-structure bg-structure/5 dark:border-gold-300" : "border-border hover:border-border-strong",
                )}
              >
                <input type="radio" name={name} value={value} checked={sector === value} onChange={() => setSector(value)} className="mt-1 size-4 shrink-0 accent-structure" />
                <Icon className="mt-0.5 size-5 shrink-0 text-structure dark:text-gold-300" aria-hidden="true" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{t(`sectors.${value}`)}</span>
                  <span className="text-xs text-foreground-muted text-pretty">{t(`sectorHints.${value}`)}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        {agency ? (
          <Field label={t("feeSchedule")} hint={t("feeScheduleHint", { max: AGENCY_FEE_SCHEDULE_MAX })} error={issue ? issues(issue) : undefined}>
            <Textarea
              value={feeSchedule}
              rows={4}
              maxLength={AGENCY_FEE_SCHEDULE_MAX}
              dir="auto"
              placeholder={t("feeSchedulePlaceholder")}
              className="min-h-28"
              onChange={(event) => setFeeSchedule(event.target.value)}
            />
          </Field>
        ) : null}
        {failure ? <FormMessage error={failure} title={t("failed")} /> : null}
        <Button type="submit" className="w-fit" loading={pending} disabled={!dirty || issue !== null}>
          {t("save")}
        </Button>
      </form>
    </section>
  );
}
