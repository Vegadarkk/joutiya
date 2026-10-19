"use client";

import { useId, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { UseFormRegisterReturn } from "react-hook-form";
import { InlineError } from "@/components/feedback/inline-error";
import { Link } from "@/i18n/navigation";

// Sign-up consents (§7): CGU, the express consent to transfers outside Morocco (art. 44 loi
// 09-08), both required, and the optional marketing opt-in, unchecked by default. The transfers
// box names each provider, its role and region (design D12); the re-consent panel of the account
// pages reuses it.

type ConsentName = "cgu" | "transfers" | "marketing";

interface ConsentFieldsProps {
  fields: Record<ConsentName, UseFormRegisterReturn>;
  errors?: Partial<Record<"cgu" | "transfers", ReactNode>>;
  /** Focus the first checkbox on mount (the consents replaced the previous screen). */
  autoFocus?: boolean;
}

function legalLink(slug: "cgu" | "confidentialite") {
  return function LegalLink(chunks: ReactNode) {
    return (
      <Link href={`/legal/${slug}`} target="_blank" rel="noopener" className="font-medium text-link underline underline-offset-2">
        {chunks}
      </Link>
    );
  };
}

export function ConsentFields({ fields, errors = {}, autoFocus }: ConsentFieldsProps) {
  const t = useTranslations("Auth.consents");
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="sr-only">{t("legend")}</legend>
      <ConsentBox field={fields.cgu} error={errors.cgu} required autoFocus={autoFocus}>
        {t.rich("cgu", { link: legalLink("cgu") })}
      </ConsentBox>
      <ConsentBox field={fields.transfers} error={errors.transfers} required details={<TransfersDetails />}>
        {t("transfers")} {t("transfersRequired")}
      </ConsentBox>
      <ConsentBox field={fields.marketing}>{t("marketing")}</ConsentBox>
      <p className="text-xs text-foreground-muted">{t.rich("privacy", { link: legalLink("confidentialite") })}</p>
    </fieldset>
  );
}

/**
 * Recipients of the transfers consent, by region (privacy policy §6.2 and §7.2). Brand names stay
 * in code, identical in every language; roles are translated. A change here is a new text: bump
 * TRANSFERS_CONSENT_VERSION so that members are asked again.
 */
export const TRANSFER_PROVIDERS = {
  eu: [
    ["Oracle Cloud", "oracle"],
    ["Google Firestore", "firestore"],
    ["Cloudflare R2", "r2"],
    ["Sentry", "sentry"],
    ["Brevo", "brevo"],
  ],
  us: [
    ["Google (Firebase Authentication)", "googleAuth"],
    ["Google (AdSense)", "adsense"],
    ["Cloudflare", "cloudflare"],
    ["Anthropic (Claude)", "anthropic"],
    ["OpenAI", "openai"],
    ["Meta (WhatsApp)", "meta"],
    ["Resend", "resend"],
    ["Stripe", "stripe"],
    ["RevenueCat", "revenuecat"],
  ],
} as const;

/** The provider list under the transfers box; `open` on the re-consent panel, whose subject it is. */
export function TransfersDetails({ open }: { open?: boolean }) {
  const t = useTranslations("Auth.consents");
  return (
    <details open={open} className="rounded-md bg-surface-muted px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium text-link underline-offset-2 hover:underline">{t("transfersDetails")}</summary>
      <div className="mt-4 flex flex-col gap-5">
        {(["eu", "us"] as const).map((region) => (
          <div key={region} className="flex flex-col gap-2">
            <p className="font-semibold">{t(region === "eu" ? "transfersEu" : "transfersUs")}</p>
            <dl className="flex flex-col gap-2">
              {TRANSFER_PROVIDERS[region].map(([name, role]) => (
                <div key={role}>
                  <dt dir="ltr" className="w-fit font-medium">
                    {name}
                  </dt>
                  <dd className="text-foreground-muted text-pretty">{t(`roles.${role}`)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
        <p className="text-xs text-foreground-muted text-pretty">{t.rich("transfersNote", { link: legalLink("confidentialite") })}</p>
      </div>
    </details>
  );
}

export function ConsentBox({
  field,
  error,
  required,
  autoFocus,
  details,
  children,
}: {
  field: UseFormRegisterReturn;
  error?: ReactNode;
  required?: boolean;
  autoFocus?: boolean;
  /** Shown under the label, outside it: a click there must not tick the box. */
  details?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
        <input
          id={id}
          type="checkbox"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          aria-required={required || undefined}
          autoFocus={autoFocus}
          className="mt-1 size-5 shrink-0 cursor-pointer rounded-sm border-border-strong accent-primary"
          {...field}
        />
        <span className="text-pretty">{children}</span>
      </label>
      {error ? (
        <InlineError id={errorId} className="ps-8">
          {error}
        </InlineError>
      ) : null}
      {details ? <div className="ps-8">{details}</div> : null}
    </div>
  );
}
