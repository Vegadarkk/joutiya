"use client";

import { useId, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { UseFormRegisterReturn } from "react-hook-form";
import { InlineError } from "@/components/feedback/inline-error";
import { Link } from "@/i18n/navigation";

// Sign-up consents (§7): CGU, the express consent to transfers outside Morocco (art. 44 loi
// 09-08), both required, and the optional marketing opt-in, unchecked by default.

type ConsentName = "cgu" | "transfers" | "marketing";

interface ConsentFieldsProps {
  fields: Record<ConsentName, UseFormRegisterReturn>;
  errors?: Partial<Record<"cgu" | "transfers", ReactNode>>;
  /** Focus the first checkbox on mount (the consents replaced the previous screen). */
  autoFocus?: boolean;
}

export function ConsentFields({ fields, errors = {}, autoFocus }: ConsentFieldsProps) {
  const t = useTranslations("Auth.consents");
  const legal = (slug: "cgu" | "confidentialite") =>
    function LegalLink(chunks: ReactNode) {
      return (
        <Link href={`/legal/${slug}`} target="_blank" rel="noopener" className="font-medium text-link underline underline-offset-2">
          {chunks}
        </Link>
      );
    };
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="sr-only">{t("legend")}</legend>
      <ConsentBox field={fields.cgu} error={errors.cgu} required autoFocus={autoFocus}>
        {t.rich("cgu", { link: legal("cgu") })}
      </ConsentBox>
      <ConsentBox field={fields.transfers} error={errors.transfers} required>
        {t("transfers")}
      </ConsentBox>
      <ConsentBox field={fields.marketing}>{t("marketing")}</ConsentBox>
      <p className="text-xs text-foreground-muted">{t.rich("privacy", { link: legal("confidentialite") })}</p>
    </fieldset>
  );
}

function ConsentBox({
  field,
  error,
  required,
  autoFocus,
  children,
}: {
  field: UseFormRegisterReturn;
  error?: ReactNode;
  required?: boolean;
  autoFocus?: boolean;
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
    </div>
  );
}
