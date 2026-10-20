"use client";

import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { BadgeCheck, KeyRound, LogOut, Mail, Smartphone } from "lucide-react";
import { useTranslations } from "next-intl";
import { useForm, useWatch } from "react-hook-form";
import type { z } from "@/lib/zod";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, inputClassName } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LOCALES, type Locale } from "@/config/site";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { ApiError, apiPost, isApiError, setSession, signOut, useSession } from "@/lib/auth/client";
import { usePublicConfig } from "@/lib/config/client";
import { AUTH_API, passwordChangeSchema, profileSchema, type SessionSummary } from "@/lib/contracts/auth";
import { toast } from "sonner";
import { FormMessage, useApiErrorMessage, useFieldMessage } from "./form-message";
import { PasswordField } from "./password-field";
import { Section } from "./settings-section";
import { AccountClosedView, CloseAccountSection, DataSection } from "@/components/account/account-sections";
import type { CloseAccountResponse } from "@/lib/contracts/account";

// /parametres. The layout already requires a member; the data comes from GET /api/auth/me (or the
// session the private layout rendered with). One page, its sections separated by rules: borders
// are kept for what they mean (a status banner, a control), not drawn around every block.

export function SettingsView() {
  const t = useTranslations("Auth.settings");
  const router = useRouter();
  const { status, session } = useSession();
  // Set by the closure (L7): the page gives way to its confirmation, whatever the session does next.
  const [closed, setClosed] = useState<CloseAccountResponse | null>(null);

  async function onSignOut() {
    await signOut();
    toast.success(t("signedOut"));
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold text-balance">{t("title")}</h1>
          <p className="text-foreground-muted text-pretty">{t("lead")}</p>
        </div>
        {closed ? null : (
          <Button type="button" variant="outline" onClick={() => void onSignOut()} className="w-fit">
            <LogOut aria-hidden="true" />
            {t("signOut")}
          </Button>
        )}
      </header>
      {closed ? (
        <AccountClosedView closed={closed} />
      ) : status !== "ready" ? (
        <LoadingSections label={t("loading")} />
      ) : !session ? (
        <SessionLost />
      ) : (
        <div className="flex flex-col divide-y divide-border">
          <ProfileSection key={`${session.uid}-${session.displayName}-${session.locale}`} session={session} />
          <PasswordSection email={session.email} displayName={session.displayName} hasPassword={session.providers.includes("password")} />
          <VerificationSection session={session} />
          <MethodsSection session={session} />
          <DataSection />
          <CloseAccountSection onClosed={setClosed} />
        </div>
      )}
    </div>
  );
}

function LoadingSections({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" className="flex flex-col divide-y divide-border">
      <span className="sr-only">{label}</span>
      {[0, 1, 2].map((index) => (
        <div key={index} className="grid gap-6 py-8 first:pt-0 sm:grid-cols-[13rem_1fr]">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-40" />
          </div>
          <div className="flex flex-col gap-3">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SessionLost() {
  const message = useApiErrorMessage();
  const t = useTranslations("Auth.signIn");
  return (
    <ErrorBanner
      title={message(new ApiError(401, "unauthenticated"))}
      action={
        <Button asChild variant="outline" size="sm">
          <Link href="/connexion">{t("submit")}</Link>
        </Button>
      }
    />
  );
}

type ProfileForm = z.input<typeof profileSchema>;
type ProfileInput = z.output<typeof profileSchema>;

function ProfileSection({ session }: { session: SessionSummary }) {
  const t = useTranslations("Auth.settings.profile");
  const names = useTranslations("Locale.names");
  const fieldMessage = useFieldMessage();
  const router = useRouter();
  const pathname = usePathname();
  const [serverError, setServerError] = useState<unknown>();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<ProfileForm, unknown, ProfileInput>({
    resolver: zodResolver(profileSchema),
    defaultValues: { displayName: session.displayName ?? "", locale: session.locale ?? "fr" },
  });

  const submit = handleSubmit(async (values) => {
    setServerError(undefined);
    try {
      const answer = await apiPost<{ session: SessionSummary }>(AUTH_API.profile, values);
      setSession(answer.session);
      toast.success(t("saved"));
      if (values.locale && values.locale !== session.locale) router.replace(pathname, { locale: values.locale });
    } catch (error) {
      setServerError(error);
    }
  });

  return (
    <Section id="profile" title={t("title")} body={t("body")}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <FormMessage error={serverError} />
        <Field label={t("displayName")} error={fieldMessage("displayName", errors.displayName)} required>
          <Input autoComplete="name" maxLength={40} {...register("displayName")} />
        </Field>
        <Field label={t("locale")} error={fieldMessage("locale", errors.locale)}>
          <select className={inputClassName} {...register("locale")}>
            {LOCALES.map((locale: Locale) => (
              <option key={locale} value={locale} lang={locale === "rif" ? "rif-Latn" : locale}>
                {names(locale)}
              </option>
            ))}
          </select>
        </Field>
        <Button type="submit" loading={isSubmitting} disabled={!isDirty} className="w-fit">
          {t("save")}
        </Button>
      </form>
    </Section>
  );
}

type PasswordForm = z.input<typeof passwordChangeSchema>;
type PasswordInput = z.output<typeof passwordChangeSchema>;

function PasswordSection({ email, displayName, hasPassword }: { email: string | null; displayName: string | null; hasPassword: boolean }) {
  const t = useTranslations("Auth.settings.password");
  return (
    <Section id="password" title={t("title")} body={t("body")}>
      {hasPassword ? <PasswordChangeForm email={email} displayName={displayName} /> : <PasswordMissing />}
    </Section>
  );
}

/**
 * No password on the account (Google only, or a never-verified password dropped by a Google
 * sign-in): there is no current password to ask for, the reset link sets one.
 */
function PasswordMissing() {
  const t = useTranslations("Auth.settings.password");
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-pretty">{t("noneBody")}</p>
      <Button asChild variant="outline" size="sm">
        <Link href="/mot-de-passe-oublie">{t("noneAction")}</Link>
      </Button>
    </div>
  );
}

function PasswordChangeForm({ email, displayName }: { email: string | null; displayName: string | null }) {
  const t = useTranslations("Auth.settings.password");
  const fieldMessage = useFieldMessage();
  const apiMessage = useApiErrorMessage();
  const [serverError, setServerError] = useState<unknown>();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    control,
    formState: { errors, isSubmitting },
  } = useForm<PasswordForm, unknown, PasswordInput>({
    resolver: zodResolver(passwordChangeSchema),
    defaultValues: { currentPassword: "", password: "" },
  });
  const password = useWatch({ control, name: "password" });

  const submit = handleSubmit(async (values) => {
    setServerError(undefined);
    try {
      const answer = await apiPost<{ status: "changed"; session: SessionSummary }>(AUTH_API.passwordChange, values);
      setSession(answer.session);
      reset();
      toast.success(t("changed"));
    } catch (error) {
      if (isApiError(error, "weak_password")) setError("password", { type: "server", message: apiMessage(error) }, { shouldFocus: true });
      else if (isApiError(error, "invalid_credentials")) setError("currentPassword", { type: "server", message: apiMessage(error) }, { shouldFocus: true });
      else setServerError(error);
    }
  });

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <FormMessage error={serverError} />
      {/* Password managers pair the new password with the account. */}
      <input type="hidden" name="username" autoComplete="username" value={email ?? ""} readOnly />
      <PasswordField label={t("current")} autoComplete="current-password" required error={fieldMessage("currentPassword", errors.currentPassword)} {...register("currentPassword")} />
      <PasswordField
        label={t("new")}
        autoComplete="new-password"
        required
        rules={{ value: password ?? "", email: email ?? "", displayName: displayName ?? "" }}
        error={fieldMessage("newPassword", errors.password)}
        {...register("password")}
      />
      <Button type="submit" variant="outline" loading={isSubmitting} className="w-fit">
        {t("save")}
      </Button>
    </form>
  );
}

export function VerificationSection({ session }: { session: SessionSummary }) {
  const t = useTranslations("Auth.settings.verification");
  // WhatsApp parked (no phone number id): the check cannot start, so no call to action leads to a 503.
  const phoneOpen = usePublicConfig()?.phoneVerification !== false;
  return (
    <Section id="verification" title={t("title")} body={t("body")}>
      <ul className="flex flex-col divide-y divide-border">
        <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0">
          <Mail className="size-5 shrink-0 text-foreground-muted" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm text-foreground-muted">{t("email")}</span>
            <span className="truncate text-start font-medium" dir="ltr">
              {session.email ?? "—"}
            </span>
          </div>
          <Badge variant={session.emailVerified ? "success" : "warning"}>
            {session.emailVerified ? <BadgeCheck className="size-3.5" aria-hidden="true" /> : null}
            {session.emailVerified ? t("emailVerified") : t("emailPending")}
          </Badge>
        </li>
        <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 last:pb-0">
          <Smartphone className="size-5 shrink-0 text-foreground-muted" aria-hidden="true" />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm text-foreground-muted">{t("phone")}</span>
            <Badge variant={session.phoneVerified ? "success" : "neutral"} className="w-fit">
              {session.phoneVerified ? <BadgeCheck className="size-3.5" aria-hidden="true" /> : null}
              {session.phoneVerified ? t("phoneVerified") : t("phoneMissing")}
            </Badge>
          </div>
          {session.phoneVerified || phoneOpen ? (
            <Button asChild variant={session.phoneVerified ? "ghost" : "structure"} size="sm">
              <Link href="/verifications">{session.phoneVerified ? t("managePhone") : t("verifyPhone")}</Link>
            </Button>
          ) : (
            <span className="text-sm text-foreground-muted">{t("phoneSoon")}</span>
          )}
        </li>
      </ul>
    </Section>
  );
}

function MethodsSection({ session }: { session: SessionSummary }) {
  const t = useTranslations("Auth.settings.methods");
  return (
    <Section id="methods" title={t("title")} body={t("body")}>
      {session.providers.length === 0 ? (
        <p className="text-sm text-foreground-muted">{t("none")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {session.providers.map((provider) => (
            <li key={provider} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
              {provider === "password" ? <KeyRound className="size-5 shrink-0 text-foreground-muted" aria-hidden="true" /> : <GoogleGlyph />}
              <span className="font-medium">{provider === "password" ? t("password") : t("google")}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="size-5 shrink-0" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.94l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06L5.84 9.9C6.71 7.31 9.14 5.38 12 5.38Z" />
    </svg>
  );
}
