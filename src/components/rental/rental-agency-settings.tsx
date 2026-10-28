"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Plane, Plus, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { CityCombobox } from "@/components/post/city-combobox";
import { Textarea } from "@/components/post/controls/textarea";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { textLinkClassName } from "@/components/ui/text-link";
import { AIRPORTS } from "@/config/airports";
import { cityBySlug, cityName, type City } from "@/config/regions";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import type { ProMeResponse, ProSelfView } from "@/lib/contracts/pro";
import { firstStrictIssue } from "@/lib/moderation/free-text";
import { loadProMe, saveRentalAgency } from "@/lib/pro/client";
import { publishesAsPro, type ProState } from "@/lib/pro/lifecycle";
import { RENTAL_AGREMENT_PATTERN, RENTAL_BRANCHES_MAX, RENTAL_HOURS_MAX, RENTAL_PAYMENTS, RENTAL_ADDRESS_MAX, type RentalAgency, type RentalPayment } from "@/lib/pro/profile-schema";
import { cn } from "@/lib/utils";

// /pro/location: a car rental agency's settings (rental pack §5): its Ministry of Transport
// licence reference (decision 3: required to publish a rental, shown « déclaré »), its branches
// (professional addresses), opening hours, payments taken on site and the airports it serves.
// The free texts follow the storefront screen (free-text.ts), live here and again on the server.

type View = { kind: "loading" } | { kind: "failed"; error: unknown } | { kind: "ready"; me: ProMeResponse };

interface Branch {
  key: number;
  city: City | null;
  address: string;
}

interface Draft {
  agrementRef: string;
  branches: Branch[];
  hours: string;
  payments: RentalPayment[];
  airports: string[];
}

let branchKey = 0;
const toBranch = (citySlug: string | null, address: string): Branch => ({ key: (branchKey += 1), city: citySlug ? (cityBySlug(citySlug) ?? null) : null, address });

function draftOf(shop: ProSelfView): Draft {
  const rental = shop.rental;
  return {
    agrementRef: rental?.agrementRef ?? "",
    // A first branch in the shop's city, to fill in.
    branches: rental ? rental.branches.map((branch) => toBranch(branch.citySlug, branch.address)) : [toBranch(shop.citySlug, "")],
    hours: rental?.hours ?? "",
    payments: rental?.payments ?? [],
    airports: rental?.airports ?? [],
  };
}

function toInput(draft: Draft): RentalAgency {
  return {
    agrementRef: draft.agrementRef.trim(),
    branches: draft.branches.filter((branch) => branch.city && branch.address.trim()).map((branch) => ({ citySlug: branch.city!.slug, address: branch.address.trim() })),
    hours: draft.hours.trim(),
    payments: RENTAL_PAYMENTS.filter((payment) => draft.payments.includes(payment)),
    airports: AIRPORTS.map((airport) => airport.id).filter((id) => draft.airports.includes(id)),
  };
}

export function RentalAgencySettingsPage() {
  const t = useTranslations("RentalAgency");
  const apiMessage = useApiErrorMessage();
  const [view, setView] = useState<View>({ kind: "loading" });
  const started = useRef(false);

  const load = useCallback(async () => {
    setView({ kind: "loading" });
    try {
      setView({ kind: "ready", me: await loadProMe() });
    } catch (error) {
      setView({ kind: "failed", error });
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  if (view.kind === "loading") {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-4">
        <span className="sr-only">{t("loading")}</span>
        <Skeleton className="h-28 w-full rounded-lg" />
        <Skeleton className="h-56 w-full rounded-lg" />
      </div>
    );
  }
  if (view.kind === "failed") {
    return (
      <FormMessage
        error={view.error}
        title={t("loadFailed")}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            {t("retry")}
          </Button>
        }
      >
        {apiMessage(view.error)}
      </FormMessage>
    );
  }
  const shop = view.me.shop;
  if (!shop || !publishesAsPro(shop.lifecycle as ProState)) {
    return (
      <ErrorBanner tone="info" title={t("notVerified")}>
        <Link href="/pro" className={cn("font-medium text-link", textLinkClassName)}>
          {t("back")}
        </Link>
      </ErrorBanner>
    );
  }
  return <RentalAgencyForm shop={shop} />;
}

function RentalAgencyForm({ shop }: { shop: ProSelfView }) {
  const t = useTranslations("RentalAgency");
  const issues = useTranslations("FreeText");
  const cities = useTranslations("Rental");
  const locale = useLocale() as Locale;
  const [draft, setDraft] = useState<Draft>(() => draftOf(shop));
  const [saved, setSaved] = useState(() => JSON.stringify(shop.rental ? toInput(draftOf(shop)) : null));
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const setBranch = (key: number, patch: Partial<Branch>) => set({ branches: draft.branches.map((branch) => (branch.key === key ? { ...branch, ...patch } : branch)) });
  const toggle = <T extends string>(list: readonly T[], value: T): T[] => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

  const agrement = draft.agrementRef.trim();
  const agrementError = !agrement ? (attempted ? t("agrementRequired") : undefined) : RENTAL_AGREMENT_PATTERN.test(agrement) ? undefined : t("agrementInvalid");
  const hoursIssue = draft.hours.trim() ? firstStrictIssue(draft.hours.trim()) : null;
  const branchErrors = new Map<number, { city?: string; address?: string }>();
  for (const branch of draft.branches) {
    const address = branch.address.trim();
    const issue = address ? firstStrictIssue(address) : null;
    const error = {
      ...(!branch.city && (address || attempted) ? { city: t("cityRequired") } : {}),
      ...(issue
        ? { address: issues(issue) }
        : address.length > 0 && address.length < 5
          ? { address: t("addressShort") }
          : !address && branch.city && attempted
            ? { address: t("addressRequired") }
            : {}),
    };
    if (error.city || error.address) branchErrors.set(branch.key, error);
  }
  const invalid = Boolean(agrementError) || !agrement || hoursIssue !== null || branchErrors.size > 0;
  const input = toInput(draft);
  const dirty = JSON.stringify(input) !== saved;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);
    if (pending || invalid || !dirty) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await saveRentalAgency(input);
      setSaved(JSON.stringify(result.rental));
      toast.success(t("saved"));
    } catch (caught) {
      setFailure(caught);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate data-testid="rental-agency-settings" className="flex flex-col gap-8">
      {shop.sector !== "car_rental" ? (
        <ErrorBanner tone="warning" title={t("sectorTitle")}>
          {t("sectorBody")}{" "}
          <Link href="/pro" className={cn("font-medium text-link", textLinkClassName)}>
            {t("sectorAction")}
          </Link>
        </ErrorBanner>
      ) : null}

      <Section title={t("agrementTitle")} lead={t("agrementLead")}>
        <Field label={t("agrement")} hint={t("agrementHint")} error={agrementError} required className="max-w-md">
          <Input
            value={draft.agrementRef}
            maxLength={40}
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            placeholder={t("agrementPlaceholder")}
            onChange={(event) => set({ agrementRef: event.target.value })}
          />
        </Field>
      </Section>

      <Section title={t("branchesTitle")} lead={t("branchesLead", { max: RENTAL_BRANCHES_MAX })}>
        <ol className="flex flex-col gap-4">
          {draft.branches.map((branch, index) => {
            const error = branchErrors.get(branch.key);
            return (
              <li key={branch.key} data-testid="rental-branch" className="flex flex-col gap-4 rounded-md border border-border bg-surface-muted/40 p-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">{t("branch", { index: index + 1 })}</h3>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => set({ branches: draft.branches.filter((item) => item.key !== branch.key) })}
                    aria-label={t("removeBranch", { index: index + 1 })}
                  >
                    <Trash2 aria-hidden="true" />
                    {t("remove")}
                  </Button>
                </div>
                <div className="grid gap-4">
                  <CityCombobox value={branch.city} onSelect={(city) => setBranch(branch.key, { city })} error={error?.city} locale={locale} />
                  <Field label={t("address")} hint={t("addressHint")} error={error?.address}>
                    <Input
                      value={branch.address}
                      maxLength={RENTAL_ADDRESS_MAX}
                      dir="auto"
                      autoComplete="off"
                      placeholder={t("addressPlaceholder")}
                      onChange={(event) => setBranch(branch.key, { address: event.target.value })}
                    />
                  </Field>
                </div>
              </li>
            );
          })}
        </ol>
        {draft.branches.length < RENTAL_BRANCHES_MAX ? (
          <Button type="button" variant="outline" className="w-fit" onClick={() => set({ branches: [...draft.branches, toBranch(null, "")] })}>
            <Plus aria-hidden="true" />
            {t("addBranch")}
          </Button>
        ) : null}
      </Section>

      <Section title={t("serviceTitle")}>
        <Field label={t("hours")} hint={t("hoursHint", { max: RENTAL_HOURS_MAX })} error={hoursIssue ? issues(hoursIssue) : undefined}>
          <Textarea
            value={draft.hours}
            rows={2}
            maxLength={RENTAL_HOURS_MAX}
            dir="auto"
            placeholder={t("hoursPlaceholder")}
            className="min-h-16"
            onChange={(event) => set({ hours: event.target.value })}
          />
        </Field>
        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2.5 text-sm font-medium">{t("payments")}</legend>
          <div className="flex flex-wrap gap-2">
            {RENTAL_PAYMENTS.map((payment) => (
              <Chip key={payment} checked={draft.payments.includes(payment)} onChange={() => set({ payments: toggle(draft.payments, payment) })}>
                {t(`paymentOptions.${payment}`)}
              </Chip>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-1 text-sm font-medium">{t("airports")}</legend>
          <p className="mb-1.5 text-sm text-foreground-muted">{t("airportsHint")}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {AIRPORTS.map((airport) => {
              const city = cityBySlug(airport.citySlug);
              return (
                <Chip
                  key={airport.id}
                  checked={draft.airports.includes(airport.id)}
                  onChange={() => set({ airports: toggle(draft.airports, airport.id) })}
                  icon={<Plane className="size-4 shrink-0" aria-hidden="true" />}
                >
                  {cities("airport", { city: city ? cityName(city, locale) : airport.citySlug, code: airport.id.toUpperCase() })}
                </Chip>
              );
            })}
          </div>
        </fieldset>
      </Section>

      {failure ? <FormMessage error={failure} title={t("failed")} /> : null}
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" loading={pending} disabled={!dirty}>
          {t("save")}
        </Button>
        {!dirty && saved !== "null" ? <p className="text-sm text-foreground-muted">{t("upToDate")}</p> : null}
      </div>
    </form>
  );
}

function Section({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5 sm:p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {lead ? <p className="max-w-prose text-sm text-foreground-muted text-pretty">{lead}</p> : null}
      </header>
      {children}
    </section>
  );
}

function Chip({ checked, onChange, icon, children }: { checked: boolean; onChange: () => void; icon?: ReactNode; children: ReactNode }) {
  return (
    <label
      className={cn(
        "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
        checked ? "border-structure bg-structure/5 font-medium dark:border-gold-300" : "border-border bg-surface hover:border-border-strong",
      )}
    >
      <input type="checkbox" checked={checked} onChange={onChange} className="size-4 shrink-0 accent-structure" />
      {icon ? <span className={checked ? "text-structure dark:text-gold-300" : "text-foreground-muted"}>{icon}</span> : null}
      <span>{children}</span>
    </label>
  );
}
