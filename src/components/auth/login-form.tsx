"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import type { z } from "@/lib/zod";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";
import { apiPost, isApiError, setSession } from "@/lib/auth/client";
import { AUTH_API, loginSchema, type LoginInput, type LoginResponse } from "@/lib/contracts/auth";
import { FormMessage, useFieldMessage } from "./form-message";
import { GoogleButton, type GoogleNeedsConsent } from "./google-button";
import { GoogleConsentStep } from "./google-consent-step";
import { OrDivider } from "./or-divider";
import { PasswordField } from "./password-field";
import { ResendVerification } from "./resend-verification";
import { TurnstileWidget, type TurnstileHandle } from "./turnstile-widget";
import { useAfterSignIn } from "./use-after-sign-in";

type LoginForm = z.input<typeof loginSchema>;

export function LoginForm({ nonce, gisNonce }: { nonce?: string; gisNonce?: string }) {
  const t = useTranslations("Auth.signIn");
  const c = useTranslations("Auth.common");
  const fieldMessage = useFieldMessage();
  const afterSignIn = useAfterSignIn();
  const turnstile = useRef<TurnstileHandle>(null);
  const resubmitOnToken = useRef(false);
  // One automatic retry per click: a server that keeps asking for Turnstile never loops.
  const automatic = useRef(false);
  const unverifiedHeading = useRef<HTMLHeadingElement>(null);
  const [serverError, setServerError] = useState<unknown>();
  const [turnstileNeeded, setTurnstileNeeded] = useState(false);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [consent, setConsent] = useState<GoogleNeedsConsent | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm, unknown, LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { email: "", password: "" }, mode: "onTouched" });

  // The "confirm your address" notice replaces nothing visible: focus tells the person it appeared.
  useEffect(() => {
    if (unverifiedEmail) unverifiedHeading.current?.focus();
  }, [unverifiedEmail]);

  async function onValid(values: LoginInput) {
    setServerError(undefined);
    try {
      const answer = await apiPost<LoginResponse>(AUTH_API.login, values);
      if (answer.status === "signed_in") {
        setSession(answer.session);
        afterSignIn();
      } else if (answer.status === "turnstile_required") {
        // Third failed attempt: the widget appears and the same credentials go again with its token.
        resubmitOnToken.current = !automatic.current;
        setTurnstileNeeded(true);
        turnstile.current?.reset();
      } else {
        setUnverifiedEmail(values.email);
      }
    } catch (error) {
      if (isApiError(error, "turnstile_required", "turnstile_failed")) setTurnstileNeeded(true);
      setValue("turnstileToken", undefined);
      turnstile.current?.reset();
      setServerError(error);
    }
  }

  function onToken(token: string | null) {
    setValue("turnstileToken", token ?? undefined);
    if (token && resubmitOnToken.current) {
      resubmitOnToken.current = false;
      automatic.current = true;
      void handleSubmit(onValid)();
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    automatic.current = false;
    void handleSubmit(onValid)(event);
  }

  if (consent) {
    return <GoogleConsentStep payload={consent} nonce={nonce} onDone={afterSignIn} onCancel={() => setConsent(null)} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <GoogleButton nonce={nonce} gisNonce={gisNonce} onSignedIn={afterSignIn} onNeedsConsent={setConsent} onError={setServerError} divider={<OrDivider label={c("or")} />} />
      {unverifiedEmail ? (
        // Its own form (resend): a sibling of the sign-in form, never nested in it.
        <section aria-labelledby="login-unverified" className="flex flex-col gap-4 rounded-lg border border-warning/30 bg-warning-surface p-5">
          <div className="flex flex-col gap-1">
            <h2 id="login-unverified" ref={unverifiedHeading} tabIndex={-1} className="rounded-sm font-semibold text-warning outline-none focus-visible:ring-3 focus-visible:ring-ring/25">
              {t("verifyTitle")}
            </h2>
            <p className="text-sm text-pretty">{t("verifyBody", { email: unverifiedEmail })}</p>
          </div>
          <ResendVerification nonce={nonce} defaultEmail={unverifiedEmail} entry="login" />
        </section>
      ) : null}
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        <FormMessage error={serverError} />
        <Field label={c("email")} error={fieldMessage("email", errors.email)} required>
          <Input type="email" inputMode="email" autoComplete="username" spellCheck={false} autoFocus dir="ltr" className="text-start" {...register("email")} />
        </Field>
        <PasswordField
          label={c("password")}
          labelAside={
            <Link href="/mot-de-passe-oublie" className="text-link underline-offset-2 hover:underline">
              {t("forgot")}
            </Link>
          }
          autoComplete="current-password"
          required
          error={fieldMessage("password", errors.password)}
          {...register("password")}
        />
        {turnstileNeeded ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-muted p-4">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">{t("turnstileTitle")}</p>
              <p className="text-sm text-foreground-muted text-pretty">{t("turnstileBody")}</p>
            </div>
            <TurnstileWidget ref={turnstile} action="login" nonce={nonce} onToken={onToken} />
          </div>
        ) : null}
        <Button type="submit" loading={isSubmitting} className="w-full">
          {t("submit")}
        </Button>
      </form>
    </div>
  );
}
