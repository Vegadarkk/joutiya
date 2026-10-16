"use client";

import { useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { MailCheck } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useForm, useWatch } from "react-hook-form";
import type { z } from "@/lib/zod";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Locale } from "@/config/site";
import { apiPost, isApiError } from "@/lib/auth/client";
import { AUTH_API, signupSchema, type SignupInput, type SignupResponse } from "@/lib/contracts/auth";
import { ConsentFields } from "./consent-fields";
import { FormMessage, useApiErrorMessage, useFieldMessage } from "./form-message";
import { GoogleButton, type GoogleNeedsConsent } from "./google-button";
import { GoogleConsentStep } from "./google-consent-step";
import { OrDivider } from "./or-divider";
import { PasswordField } from "./password-field";
import { ResendVerification } from "./resend-verification";
import { StatusPanel } from "./status-panel";
import { TurnstileWidget, type TurnstileHandle } from "./turnstile-widget";
import { useAfterSignIn } from "./use-after-sign-in";

type SignupForm = z.input<typeof signupSchema>;

export function SignupForm({ nonce }: { nonce?: string }) {
  const t = useTranslations("Auth.signUp");
  const c = useTranslations("Auth.common");
  const locale = useLocale() as Locale;
  const fieldMessage = useFieldMessage();
  const apiMessage = useApiErrorMessage();
  const afterSignIn = useAfterSignIn();
  const turnstile = useRef<TurnstileHandle>(null);
  const [serverError, setServerError] = useState<unknown>();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [consent, setConsent] = useState<GoogleNeedsConsent | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    setError,
    control,
    formState: { errors, isSubmitting, submitCount },
  } = useForm<SignupForm, unknown, SignupInput>({
    resolver: zodResolver(signupSchema),
    defaultValues: { email: "", password: "", displayName: "", locale, consents: { marketing: false }, turnstileToken: "" },
  });
  const password = useWatch({ control, name: "password" });
  const email = useWatch({ control, name: "email" });

  async function onValid(values: SignupInput) {
    setServerError(undefined);
    try {
      await apiPost<SignupResponse>(AUTH_API.signup, values);
      setSentTo(values.email);
    } catch (error) {
      // Tokens are single use: the next attempt needs a fresh one.
      turnstile.current?.reset();
      if (isApiError(error, "weak_password")) setError("password", { type: "server", message: apiMessage(error) }, { shouldFocus: true });
      else if (isApiError(error, "disposable_email")) setError("email", { type: "server", message: apiMessage(error) }, { shouldFocus: true });
      else setServerError(error);
    }
  }

  if (sentTo) {
    return (
      <div className="flex flex-col gap-8">
        <StatusPanel icon={MailCheck} title={t("sentTitle")}>
          {t("sentBody", { email: sentTo })}
        </StatusPanel>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-foreground-muted">{t("sentHelp")}</p>
          <ResendVerification nonce={nonce} defaultEmail={sentTo} action="verify_resend_signup" />
        </div>
      </div>
    );
  }

  if (consent) {
    return <GoogleConsentStep payload={consent} nonce={nonce} onDone={afterSignIn} onCancel={() => setConsent(null)} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <GoogleButton nonce={nonce} onSignedIn={afterSignIn} onNeedsConsent={setConsent} onError={setServerError} divider={<OrDivider label={c("or")} />} />
      <form onSubmit={(event) => void handleSubmit(onValid)(event)} noValidate className="flex flex-col gap-5">
        <FormMessage error={serverError} />
        <Field label={t("displayName")} hint={t("displayNameHint")} error={fieldMessage("displayName", errors.displayName)} required>
          <Input autoComplete="name" maxLength={40} {...register("displayName")} />
        </Field>
        <Field label={c("email")} error={fieldMessage("email", errors.email)} required>
          <Input type="email" inputMode="email" autoComplete="email" spellCheck={false} {...register("email")} />
        </Field>
        <PasswordField
          label={c("password")}
          autoComplete="new-password"
          required
          rules={{ value: password ?? "", email: email ?? "" }}
          error={fieldMessage("newPassword", errors.password)}
          {...register("password")}
        />
        <ConsentFields
          fields={{ cgu: register("consents.cgu"), transfers: register("consents.transfers"), marketing: register("consents.marketing") }}
          errors={{ cgu: fieldMessage("consent", errors.consents?.cgu), transfers: fieldMessage("consent", errors.consents?.transfers) }}
        />
        <TurnstileWidget
          ref={turnstile}
          action="signup"
          nonce={nonce}
          onToken={(token) => setValue("turnstileToken", token ?? "", { shouldValidate: submitCount > 0 })}
          error={errors.turnstileToken ? c("turnstilePending") : undefined}
        />
        <Button type="submit" loading={isSubmitting} className="w-full">
          {t("submit")}
        </Button>
      </form>
    </div>
  );
}
