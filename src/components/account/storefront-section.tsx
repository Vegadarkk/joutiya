"use client";

import { useEffect, useState } from "react";
import { Check, ExternalLink, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FormMessage } from "@/components/auth/form-message";
import { Section } from "@/components/auth/settings-section";
import { CityCombobox } from "@/components/post/city-combobox";
import { StorefrontBanner } from "@/components/profile/storefront-banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { inputClassName } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cityBySlug, type City } from "@/config/regions";
import { BANNER_KEYS, BIO_MAX, type BannerKey } from "@/config/storefront";
import { Link } from "@/i18n/navigation";
import { apiGet, apiPost } from "@/lib/auth/client";
import type { StorefrontSettings } from "@/lib/contracts/account";
import { ACCOUNT_API } from "@/lib/contracts/endpoints";
import { firstStrictIssue } from "@/lib/moderation/free-text";
import { cn } from "@/lib/utils";

// "Ma vitrine" in /parametres (vitrine-avis §1): house banner, "about" text screened as it is
// typed (the API screens it again), the city shown on the profile. One save for the three.

export function StorefrontSection() {
  const t = useTranslations("Auth.settings.storefront");
  const [saved, setSaved] = useState<StorefrontSettings | null>(null);
  const [loadError, setLoadError] = useState<unknown>();

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    apiGet<StorefrontSettings>(ACCOUNT_API.storefront).then(
      (settings) => live && setSaved(settings),
      (error: unknown) => live && setLoadError(error),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  function retry() {
    setLoadError(undefined);
    setAttempt((count) => count + 1);
  }

  return (
    <Section id="storefront" title={t("title")} body={t("body")}>
      {saved ? (
        <StorefrontForm key={`${saved.bannerKey}-${saved.bio}-${saved.citySlug}`} saved={saved} onSaved={setSaved} />
      ) : loadError ? (
        <FormMessage
          error={loadError}
          action={
            <Button type="button" variant="outline" size="sm" onClick={retry}>
              {t("retry")}
            </Button>
          }
        />
      ) : (
        <div role="status" aria-busy="true" className="flex flex-col gap-4">
          <span className="sr-only">{t("loading")}</span>
          <div className="grid grid-cols-3 gap-3">
            {BANNER_KEYS.map((key) => (
              <Skeleton key={key} className="h-16 w-full" />
            ))}
          </div>
          <Skeleton className="h-28 w-full" />
        </div>
      )}
    </Section>
  );
}

function StorefrontForm({ saved, onSaved }: { saved: StorefrontSettings; onSaved: (next: StorefrontSettings) => void }) {
  const t = useTranslations("Auth.settings.storefront");
  const issues = useTranslations("FreeText");
  const [bannerKey, setBannerKey] = useState<BannerKey>(saved.bannerKey);
  const [bio, setBio] = useState(saved.bio);
  const [city, setCity] = useState<City | null>(saved.citySlug ? (cityBySlug(saved.citySlug) ?? null) : null);
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState<unknown>();

  const trimmed = bio.trim();
  const issue = trimmed ? firstStrictIssue(trimmed) : null;
  const length = [...bio].length;
  const dirty = bannerKey !== saved.bannerKey || trimmed !== saved.bio || (city?.slug ?? null) !== saved.citySlug;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (issue || !dirty) return;
    setPending(true);
    setServerError(undefined);
    try {
      const next = await apiPost<StorefrontSettings>(ACCOUNT_API.storefront, { bannerKey, bio: trimmed || null, citySlug: city?.slug ?? null });
      toast.success(t("saved"));
      onSaved(next);
    } catch (error) {
      setServerError(error);
    } finally {
      setPending(false);
    }
  }

  return (
    <form method="post" onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-6">
      <FormMessage error={serverError} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">{t("banner")}</legend>
        <div role="radiogroup" aria-label={t("banner")} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {BANNER_KEYS.map((key) => {
            const checked = key === bannerKey;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => setBannerKey(key)}
                className="group flex flex-col gap-1.5 rounded-md text-start"
              >
                <span className={cn("relative block h-16 overflow-hidden rounded-md ring-offset-2 ring-offset-background transition-shadow", checked ? "ring-3 ring-primary" : "ring-1 ring-border group-hover:ring-border-strong")}>
                  <StorefrontBanner bannerKey={key} id={`picker-${key}`} />
                  {checked ? (
                    <span className="absolute end-1.5 top-1.5 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="size-4" aria-hidden="true" />
                    </span>
                  ) : null}
                </span>
                <span className={cn("text-sm", checked ? "font-medium" : "text-foreground-muted")}>{t(`banners.${key}`)}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <Field label={t("bio")} hint={t("bioHint")} error={issue ? issues(issue) : undefined}>
        <textarea rows={5} maxLength={BIO_MAX} value={bio} onChange={(event) => setBio(event.target.value)} dir="auto" className={cn(inputClassName, "h-auto min-h-32 py-3 leading-relaxed")} />
      </Field>
      <p aria-live="polite" className={cn("-mt-4 text-end text-xs tabular-nums", length > BIO_MAX - 50 ? "text-warning" : "text-foreground-muted")}>
        {t("bioCount", { count: length, max: BIO_MAX })}
      </p>

      <div className="flex flex-col gap-2">
        <CityCombobox value={city} onSelect={setCity} />
        <p className="text-sm text-foreground-muted">{t("cityHint")}</p>
        {city ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setCity(null)} className="w-fit">
            <X aria-hidden="true" />
            {t("cityRemove")}
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending} disabled={!dirty || issue !== null}>
          {t("save")}
        </Button>
        <Button asChild variant="outline">
          <Link href={`/profil/${saved.publicId}`} prefetch={false}>
            <ExternalLink aria-hidden="true" />
            {t("view")}
          </Link>
        </Button>
      </div>
    </form>
  );
}
