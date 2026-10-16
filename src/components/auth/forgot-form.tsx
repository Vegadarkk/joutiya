"use client";

import { useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { MailCheck } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import type { z } from "@/lib/zod";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { apiPost } from "@/lib/auth/client";
import { AUTH_API, resetRequestSchema, type ResetRequestInput, type ResetRequestResponse } from "@/lib/contracts/auth";
import { FormMessage, useFieldMessage } from "./form-message";
import { StatusPanel } from "./status-panel";
import { TurnstileWidget, type TurnstileHandle } from "./turnstile-widget";

type ForgotForm = z.input<typeof resetRequestSchema>;

export function ForgotForm({ nonce }: { nonce?: string }) {
  const t = useTranslations("Auth.forgot");
  const c = useTranslations("Auth.common");
  const locale = useLocale() as Locale;
  const fieldMessage = useFieldMessage();
  const turnstile = useRef<TurnstileHandle>(null);
  const [serverError, setServerError] = useState<unknown>();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting, submitCount },
  } = useForm<ForgotForm, unknown, ResetRequestInput>({
    resolver: zodResolver(resetRequestSchema),
    defaultValues: { email: "", locale, turnstileToken: "" },
  });

  async function onValid(values: ResetRequestInput) {
    setServerError(undefined);
    try {
      await apiPost<ResetRequestResponse>(AUTH_API.resetRequest, values);
      setSentTo(values.email);
    } catch (error) {
      turnstile.current?.reset();
      setServerError(error);
    }
  }

  if (sentTo) {
    return (
      <StatusPanel
        icon={MailCheck}
        title={t("sentTitle")}
        actions={
          <Button asChild variant="outline">
            <Link href="/connexion">{t("back")}</Link>
          </Button>
        }
      >
        {t("sentBody", { email: sentTo })}
      </StatusPanel>
    );
  }

  return (
    <form onSubmit={(event) => void handleSubmit(onValid)(event)} noValidate className="flex flex-col gap-5">
      <FormMessage error={serverError} />
      <Field label={c("email")} error={fieldMessage("email", errors.email)} required>
        <Input type="email" inputMode="email" autoComplete="username" spellCheck={false} autoFocus dir="ltr" className="text-start" {...register("email")} />
      </Field>
      <TurnstileWidget
        ref={turnstile}
        action="reset"
        nonce={nonce}
        onToken={(token) => setValue("turnstileToken", token ?? "", { shouldValidate: submitCount > 0 })}
        error={errors.turnstileToken ? c("turnstilePending") : undefined}
      />
      <Button type="submit" loading={isSubmitting} className="w-full">
        {t("submit")}
      </Button>
    </form>
  );
}
