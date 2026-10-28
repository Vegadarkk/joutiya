"use client";

import { useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { MailCheck } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { z } from "@/lib/zod";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiPost } from "@/lib/auth/client";
import { AUTH_API, emailSchema, localeSchema, turnstileTokenSchema } from "@/lib/contracts/auth";
import type { Locale } from "@/config/site";
import { FormMessage, useFieldMessage } from "./form-message";
import { StatusPanel } from "./status-panel";
import { TurnstileWidget, type TurnstileHandle } from "./turnstile-widget";

// Same shape as verifyResendSchema (no session needed: e-mail, locale, Turnstile), built from the
// shared primitives so the validation matches the server's.
const resendSchema = z.object({ email: emailSchema, locale: localeSchema, turnstileToken: turnstileTokenSchema }).strict();
type ResendForm = z.input<typeof resendSchema>;
type ResendInput = z.output<typeof resendSchema>;

interface ResendVerificationProps {
  nonce?: string;
  defaultEmail?: string;
  /** Which screen hosts the form (Turnstile statistics only; the action stays `verify-resend`). */
  entry: "login" | "signup" | "action";
  className?: string;
}

/** "Receive a new link": e-mail + Turnstile -> POST verify/resend, then a neutral confirmation. */
export function ResendVerification({ nonce, defaultEmail = "", entry, className }: ResendVerificationProps) {
  const t = useTranslations("Auth.resend");
  const c = useTranslations("Auth.common");
  const locale = useLocale() as Locale;
  const fieldMessage = useFieldMessage();
  const turnstile = useRef<TurnstileHandle>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [serverError, setServerError] = useState<unknown>();
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting, submitCount },
  } = useForm<ResendForm, unknown, ResendInput>({
    resolver: zodResolver(resendSchema),
    defaultValues: { email: defaultEmail, locale, turnstileToken: "" },
    mode: "onTouched",
  });

  async function onValid(values: ResendInput) {
    setServerError(undefined);
    try {
      await apiPost<{ status: "sent" }>(AUTH_API.verifyResend, values);
      setSentTo(values.email);
    } catch (error) {
      setServerError(error);
      turnstile.current?.reset();
    }
  }

  if (sentTo) {
    return (
      <StatusPanel icon={MailCheck} title={t("sentTitle")} headingLevel="h3" className={className}>
        {t("sentBody", { email: sentTo })}
      </StatusPanel>
    );
  }
  return (
    <form onSubmit={(event) => void handleSubmit(onValid)(event)} noValidate className={className}>
      <div className="flex flex-col gap-4">
        <h3 className="font-semibold">{t("title")}</h3>
        <FormMessage error={serverError} />
        <Field label={c("email")} error={fieldMessage("email", errors.email)} required>
          <Input type="email" inputMode="email" autoComplete="email" spellCheck={false} dir="ltr" className="text-start" {...register("email")} />
        </Field>
        <TurnstileWidget
          ref={turnstile}
          action="verify-resend"
          cData={`verify-resend-${entry}`}
          nonce={nonce}
          onToken={(token) => setValue("turnstileToken", token ?? "", { shouldValidate: submitCount > 0 })}
          error={errors.turnstileToken ? c("turnstilePending") : undefined}
        />
        <Button type="submit" variant="outline" loading={isSubmitting} className="w-fit">
          {t("submit")}
        </Button>
      </div>
    </form>
  );
}
