"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { CircleCheck, KeyRound, LinkIcon, TimerOff } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useForm, useWatch } from "react-hook-form";
import { z } from "@/lib/zod";
import { Button } from "@/components/ui/button";
import { KhatamLoader } from "@/components/ui/khatam-loader";
import { Link } from "@/i18n/navigation";
import { apiPost, isApiError, setSession } from "@/lib/auth/client";
import { AUTH_API, passwordSchema, type ActionResponse, type SessionSummary } from "@/lib/contracts/auth";
import { markWelcomeSeen, queueDoorOpening } from "@/lib/welcome/flags";
import { FormMessage, useApiErrorMessage, useFieldMessage } from "./form-message";
import { PasswordField } from "./password-field";
import { ResendVerification } from "./resend-verification";
import { StatusPanel } from "./status-panel";
import { useHydrated } from "./use-hydrated";

// /action?mode=verifyEmail|resetPassword&oobCode=...: the code is read in the browser and posted
// to /api/auth/action, never fetched server side (it stays out of logs and caches). Once read, it is
// also removed from the address bar and the history entry: the single-use code should not survive a
// reload, a shared screenshot or the browser history.

type Mode = "verifyEmail" | "resetPassword";

type State =
  | { kind: "missing" }
  | { kind: "working" }
  | { kind: "verified"; session: SessionSummary | null }
  | { kind: "reset"; email: string }
  | { kind: "resetDone" }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "failed"; error: unknown };

function readMode(value: string | null): Mode | null {
  return value === "verifyEmail" || value === "resetPassword" ? value : null;
}

export function ActionView({ nonce }: { nonce?: string }) {
  const params = useSearchParams();
  // Read once: the URL is cleaned right after, so the search params must not be re-read.
  const [{ mode, oobCode }] = useState(() => ({ mode: readMode(params.get("mode")), oobCode: params.get("oobCode") }));
  const t = useTranslations("Auth.action");
  const [state, setState] = useState<State>(() => (mode && oobCode ? { kind: "working" } : { kind: "missing" }));
  const started = useRef(false);

  const run = useCallback(async () => {
    if (!mode || !oobCode) return;
    setState({ kind: "working" });
    try {
      const answer = await apiPost<ActionResponse>(AUTH_API.action, { mode, oobCode });
      if (answer.status === "verified") {
        if (answer.session) {
          setSession(answer.session);
          // A member's device: the home page no longer greets it with the welcome screen.
          markWelcomeSeen();
        }
        setState({ kind: "verified", session: answer.session });
      } else {
        setState({ kind: "reset", email: answer.email });
      }
    } catch (error) {
      if (isApiError(error, "invalid_code")) setState({ kind: "invalid" });
      else if (isApiError(error, "expired_code")) setState({ kind: "expired" });
      else setState({ kind: "failed", error });
    }
  }, [mode, oobCode]);

  useEffect(() => {
    // One call per page load (React strict mode runs effects twice in development).
    if (started.current) return;
    started.current = true;
    if (oobCode) window.history.replaceState(null, "", window.location.pathname);
    void run();
  }, [run, oobCode]);

  if (state.kind === "missing") {
    return (
      <StatusPanel icon={LinkIcon} title={t("missingTitle")} actions={<HomeLink />}>
        {t("missingBody")}
      </StatusPanel>
    );
  }
  if (state.kind === "working") {
    return (
      <div role="status" className="flex items-center gap-3 rounded-lg border border-border bg-surface-muted px-5 py-6 text-foreground-muted">
        <KhatamLoader size="sm" />
        <span>{mode === "verifyEmail" ? t("verifying") : t("checking")}</span>
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <FormMessage
        error={state.error}
        title={t("failedTitle")}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => void run()}>
            {t("retry")}
          </Button>
        }
      >
        <ApiMessage error={state.error} />
      </FormMessage>
    );
  }
  if (state.kind === "verified") {
    return (
      <StatusPanel
        icon={CircleCheck}
        title={t("verifiedTitle")}
        actions={
          state.session ? (
            <>
              <Button asChild>
                <Link href="/parametres">{t("goSettings")}</Link>
              </Button>
              <Button asChild variant="outline">
                {/* The account is created: the door of the home page opens for it (once per device). */}
                <Link href="/" onClick={queueDoorOpening}>
                  {t("goHome")}
                </Link>
              </Button>
            </>
          ) : (
            <Button asChild>
              <Link href="/connexion">{t("goSignIn")}</Link>
            </Button>
          )
        }
      >
        {state.session ? t("verifiedBody") : t("verifiedBodyAnonymous")}
      </StatusPanel>
    );
  }
  if (state.kind === "reset" && oobCode) {
    return <ResetPasswordForm oobCode={oobCode} email={state.email} onDone={() => setState({ kind: "resetDone" })} />;
  }
  if (state.kind === "resetDone") {
    return (
      <StatusPanel
        icon={CircleCheck}
        title={t("resetDoneTitle")}
        actions={
          <Button asChild>
            <Link href="/connexion">{t("goSignIn")}</Link>
          </Button>
        }
      >
        {t("resetDoneBody")}
      </StatusPanel>
    );
  }
  // invalid or expired
  const expired = state.kind === "expired";
  if (mode === "resetPassword") {
    return (
      <StatusPanel
        icon={expired ? TimerOff : LinkIcon}
        title={expired ? t("expiredTitle") : t("invalidTitle")}
        actions={
          <Button asChild>
            <Link href="/mot-de-passe-oublie">{t("requestNew")}</Link>
          </Button>
        }
      >
        {expired ? t("resetExpiredBody") : t("invalidBody")}
      </StatusPanel>
    );
  }
  return (
    <StatusPanel
      icon={expired ? TimerOff : LinkIcon}
      title={expired ? t("expiredTitle") : t("invalidTitle")}
      extra={<ResendVerification nonce={nonce} entry="action" className="mt-2 rounded-md bg-surface p-4" />}
    >
      {expired ? t("expiredBody") : t("invalidBody")}
    </StatusPanel>
  );
}

function ApiMessage({ error }: { error: unknown }) {
  const message = useApiErrorMessage();
  return <>{message(error)}</>;
}

function HomeLink() {
  const t = useTranslations("Auth.common");
  return (
    <Button asChild variant="outline">
      <Link href="/">{t("backHome")}</Link>
    </Button>
  );
}

const resetFormSchema = z.object({ password: passwordSchema }).strict();
type ResetForm = z.input<typeof resetFormSchema>;

function ResetPasswordForm({ oobCode, email, onDone }: { oobCode: string; email: string; onDone: () => void }) {
  const t = useTranslations("Auth.action");
  const fieldMessage = useFieldMessage();
  const apiMessage = useApiErrorMessage();
  const [serverError, setServerError] = useState<unknown>();
  const hydrated = useHydrated();
  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors, isSubmitting },
  } = useForm<ResetForm>({ resolver: zodResolver(resetFormSchema), defaultValues: { password: "" }, mode: "onTouched" });
  const password = useWatch({ control, name: "password" });

  async function onValid(values: ResetForm) {
    setServerError(undefined);
    try {
      await apiPost<{ status: "password_reset" }>(AUTH_API.resetConfirm, { oobCode, password: values.password });
      onDone();
    } catch (error) {
      if (isApiError(error, "weak_password")) setError("password", { type: "server", message: apiMessage(error) }, { shouldFocus: true });
      else setServerError(error);
    }
  }

  return (
    <form method="post" onSubmit={(event) => void handleSubmit(onValid)(event)} noValidate className="flex flex-col gap-5">
      <div className="flex items-center gap-3 rounded-md bg-surface-muted px-4 py-3 text-sm">
        <KeyRound className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="text-pretty">{t("resetLead", { email })}</span>
      </div>
      <FormMessage error={serverError} />
      <PasswordField
        label={t("newPassword")}
        autoComplete="new-password"
        required
        autoFocus
        rules={{ value: password ?? "", email }}
        error={fieldMessage("newPassword", errors.password)}
        {...register("password")}
      />
      {/* Password managers read the account from this hidden field. */}
      <input type="hidden" name="username" autoComplete="username" value={email} readOnly />
      <Button type="submit" loading={isSubmitting} disabled={!hydrated} className="w-full">
        {t("resetSubmit")}
      </Button>
    </form>
  );
}
