"use client";

import { useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useLocale, useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { z } from "@/lib/zod";
import { Button } from "@/components/ui/button";
import { apiPost, setSession } from "@/lib/auth/client";
import { AUTH_API, consentsSchema, turnstileTokenSchema, type GoogleResponse, type SessionSummary } from "@/lib/contracts/auth";
import type { Locale } from "@/config/site";
import { ConsentFields } from "./consent-fields";
import { FormMessage, useFieldMessage } from "./form-message";
import type { GoogleNeedsConsent } from "./google-button";
import { TurnstileWidget, type TurnstileHandle } from "./turnstile-widget";

// Second step of a Google sign-up: the account is created only once the consents are given
// (§6, §7). The same credential is posted again, now with consents and a Turnstile token.
const consentStepSchema = z.object({ consents: consentsSchema, turnstileToken: turnstileTokenSchema }).strict();
type ConsentForm = z.input<typeof consentStepSchema>;
type ConsentInput = z.output<typeof consentStepSchema>;

interface GoogleConsentStepProps {
  payload: GoogleNeedsConsent;
  nonce?: string;
  onDone: (session: SessionSummary) => void;
  onCancel: () => void;
}

export function GoogleConsentStep({ payload, nonce, onDone, onCancel }: GoogleConsentStepProps) {
  const t = useTranslations("Auth.signUp");
  const c = useTranslations("Auth.common");
  const locale = useLocale() as Locale;
  const fieldMessage = useFieldMessage();
  const turnstile = useRef<TurnstileHandle>(null);
  const [serverError, setServerError] = useState<unknown>();
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting, submitCount },
  } = useForm<ConsentForm, unknown, ConsentInput>({
    resolver: zodResolver(consentStepSchema),
    defaultValues: { consents: { marketing: false }, turnstileToken: "" },
  });

  async function onValid(values: ConsentInput) {
    setServerError(undefined);
    try {
      const answer = await apiPost<GoogleResponse>(AUTH_API.google, { credential: payload.credential, locale, ...values });
      if (answer.status === "signed_in") {
        setSession(answer.session);
        onDone(answer.session);
      } else {
        setServerError(new Error("needs_consent"));
        turnstile.current?.reset();
      }
    } catch (error) {
      setServerError(error);
      turnstile.current?.reset();
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(onValid)(event)} noValidate className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">{t("consentTitle")}</h2>
        <p className="text-foreground-muted text-pretty">{t("consentBody")}</p>
      </div>
      <dl className="rounded-md bg-surface-muted px-4 py-3">
        <dt className="text-xs text-foreground-muted">{t("consentEmail")}</dt>
        <dd className="font-medium break-all">
          {payload.displayName ? `${payload.displayName} · ` : null}
          <span dir="ltr">{payload.email}</span>
        </dd>
      </dl>
      <FormMessage error={serverError} />
      <ConsentFields
        fields={{ cgu: register("consents.cgu"), transfers: register("consents.transfers"), marketing: register("consents.marketing") }}
        errors={{ cgu: fieldMessage("consent", errors.consents?.cgu), transfers: fieldMessage("consent", errors.consents?.transfers) }}
      />
      <TurnstileWidget
        ref={turnstile}
        action="google_signup"
        nonce={nonce}
        onToken={(token) => setValue("turnstileToken", token ?? "", { shouldValidate: submitCount > 0 })}
        error={errors.turnstileToken ? c("turnstilePending") : undefined}
      />
      <div className="flex flex-col gap-3 sm:flex-row-reverse">
        <Button type="submit" loading={isSubmitting} className="w-full sm:flex-1">
          {t("consentSubmit")}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="w-full sm:w-auto">
          {t("consentCancel")}
        </Button>
      </div>
    </form>
  );
}
