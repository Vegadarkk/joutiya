"use client";

import { useEffect, useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { BadgeCheck, Check, Copy, MessageCircle, Timer } from "lucide-react";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import type { z } from "@/lib/zod";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Link } from "@/i18n/navigation";
import { apiGet, apiPost, isApiError, refreshSession } from "@/lib/auth/client";
import { AUTH_API, phoneStartSchema, type PhoneStartResponse, type PhoneStatusResponse } from "@/lib/contracts/auth";
import { FormMessage, useApiErrorMessage, useFieldMessage } from "./form-message";
import { StatusPanel } from "./status-panel";

// /verifications: WhatsApp phone verification (§6). The person sends the code from their own
// WhatsApp to Joutiya's number; the webhook sets the badge; this page polls the status.

const POLL_MS = 5_000;

type State =
  | { kind: "loading" }
  | { kind: "idle" }
  | { kind: "pendingUnknown"; phone: string | null }
  | { kind: "pending"; phone: string; code: string; waLink: string; number: string; expiresAt: number }
  | { kind: "verified"; phone: string | null }
  | { kind: "expired"; phone: string | null }
  | { kind: "unavailable" };

type PhoneForm = z.input<typeof phoneStartSchema>;
type PhoneInput = z.output<typeof phoneStartSchema>;

export function VerificationsView() {
  const t = useTranslations("Auth.verifications");
  const [state, setState] = useState<State>({ kind: "loading" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    apiGet<PhoneStatusResponse>(AUTH_API.phoneStatus).then(
      (status) => {
        if (status.status === "verified") setState({ kind: "verified", phone: status.phone });
        else if (status.status === "pending") setState({ kind: "pendingUnknown", phone: status.phone });
        else if (status.status === "expired") setState({ kind: "expired", phone: status.phone });
        else setState({ kind: "idle" });
      },
      (error: unknown) => setState(isApiError(error, "unavailable") ? { kind: "unavailable" } : { kind: "idle" }),
    );
  }, []);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-balance">{t("title")}</h1>
        <p className="text-foreground-muted text-pretty">{t("lead")}</p>
      </header>
      {state.kind === "loading" ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-4 rounded-lg border border-border p-6">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : state.kind === "unavailable" ? (
        <ErrorBanner tone="info" title={t("unavailable")} action={<BackToSettings />} />
      ) : state.kind === "verified" ? (
        <StatusPanel icon={BadgeCheck} title={t("verifiedTitle")} extra={<VerifiedBadge />} actions={<BackToSettings />}>
          {t("verifiedBody", { phone: state.phone ?? "" })}
        </StatusPanel>
      ) : state.kind === "pending" ? (
        <PendingCode state={state} onExpired={() => setState({ kind: "expired", phone: state.phone })} onVerified={() => setState({ kind: "verified", phone: state.phone })} onChange={() => setState({ kind: "idle" })} />
      ) : (
        <div className="flex flex-col gap-6">
          {state.kind === "expired" ? (
            <ErrorBanner tone="warning" title={t("expiredTitle")}>
              {t("expiredBody")}
            </ErrorBanner>
          ) : state.kind === "pendingUnknown" ? (
            <ErrorBanner tone="info" title={t("pendingTitle")}>
              {t("pendingBody", { phone: state.phone ?? "" })}
            </ErrorBanner>
          ) : null}
          <PhoneForm defaultPhone={state.kind === "idle" ? "" : (state.phone ?? "")} onStarted={(pending) => setState(pending)} onUnavailable={() => setState({ kind: "unavailable" })} />
        </div>
      )}
    </div>
  );
}

function VerifiedBadge() {
  const t = useTranslations("Auth.verifications");
  return (
    <div className="flex justify-center">
      <Badge variant="success" className="px-3 py-1 text-sm">
        <BadgeCheck className="size-4" aria-hidden="true" />
        {t("badge")}
      </Badge>
    </div>
  );
}

function BackToSettings() {
  const t = useTranslations("Auth.verifications");
  return (
    <Button asChild variant="outline">
      <Link href="/parametres">{t("backSettings")}</Link>
    </Button>
  );
}

function PhoneForm({
  defaultPhone,
  onStarted,
  onUnavailable,
}: {
  defaultPhone: string;
  onStarted: (state: Extract<State, { kind: "pending" }>) => void;
  onUnavailable: () => void;
}) {
  const t = useTranslations("Auth.verifications");
  const fieldMessage = useFieldMessage();
  const apiMessage = useApiErrorMessage();
  const [serverError, setServerError] = useState<unknown>();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<PhoneForm, unknown, PhoneInput>({ resolver: zodResolver(phoneStartSchema), defaultValues: { phone: defaultPhone } });

  const submit = handleSubmit(async ({ phone }) => {
    setServerError(undefined);
    try {
      const answer = await apiPost<PhoneStartResponse>(AUTH_API.phoneStart, { phone });
      onStarted({ kind: "pending", phone, code: answer.code, waLink: answer.waLink, number: answer.number, expiresAt: Date.parse(answer.expiresAt) });
    } catch (error) {
      if (isApiError(error, "unavailable")) onUnavailable();
      else if (isApiError(error, "phone_invalid", "phone_not_mobile", "conflict")) setError("phone", { type: "server", message: apiMessage(error) }, { shouldFocus: true });
      else setServerError(error);
    }
  });

  return (
    <section className="flex flex-col gap-6 rounded-lg border border-border bg-surface p-6">
      <div className="flex gap-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-success-surface text-success">
          <MessageCircle className="size-5" aria-hidden="true" />
        </span>
        <p className="text-pretty">{t("how")}</p>
      </div>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <FormMessage error={serverError} />
        <Field label={t("phone")} hint={t("phoneHint")} error={fieldMessage("phone", errors.phone)} required>
          <Input type="tel" inputMode="tel" autoComplete="tel" dir="ltr" placeholder="06 12 34 56 78" className="text-start" {...register("phone")} />
        </Field>
        <Button type="submit" loading={isSubmitting} className="w-full sm:w-fit">
          {t("start")}
        </Button>
      </form>
    </section>
  );
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function PendingCode({
  state,
  onExpired,
  onVerified,
  onChange,
}: {
  state: Extract<State, { kind: "pending" }>;
  onExpired: () => void;
  onVerified: () => void;
  onChange: () => void;
}) {
  const t = useTranslations("Auth.verifications");
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const remaining = state.expiresAt - now;

  // Countdown, one tick a second.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (remaining <= 0) onExpired();
  }, [remaining, onExpired]);

  // Status poll until the webhook has seen the message.
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const status = await apiGet<PhoneStatusResponse>(AUTH_API.phoneStatus);
        if (!active) return;
        if (status.status === "verified") {
          void refreshSession();
          onVerified();
        } else if (status.status === "expired") {
          onExpired();
        }
      } catch {
        // Transient failure: the next tick asks again.
      }
    };
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [onVerified, onExpired]);

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(state.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard blocked: the code is large enough to retype.
    }
  }

  return (
    <section className="flex flex-col gap-6 rounded-lg border border-border bg-surface p-6" aria-live="polite">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{t("codeTitle")}</h2>
        <p className="text-foreground-muted text-pretty">{t("codeBody", { phone: state.phone })}</p>
      </div>
      <div className="arch flex flex-col items-center gap-3 rounded-b-lg bg-surface-brand px-6 pb-6 pt-10 text-center">
        <span className="text-sm text-foreground-muted">{t("codeLabel")}</span>
        <p dir="ltr" className="text-4xl font-semibold tracking-[0.35em] tabular-nums text-foreground ps-[0.35em]">
          {state.code}
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={copyCode}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? t("copied") : t("copyCode")}
        </Button>
      </div>
      <div className="flex flex-col gap-3">
        <Button asChild size="lg" className="w-full bg-[#1daa61] text-white hover:bg-[#178f52] dark:text-white">
          <a href={state.waLink} target="_blank" rel="noopener noreferrer">
            <MessageCircle aria-hidden="true" />
            {t("openWhatsApp")}
          </a>
        </Button>
        <p className="text-center text-sm text-foreground-muted">
          {t("joutiyaNumber")}{" "}
          <span dir="ltr" className="font-medium text-foreground">
            {state.number}
          </span>
        </p>
      </div>
      <div className="flex flex-col gap-2 border-t border-border pt-4 text-sm text-foreground-muted sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-2">
          <Spinner className="size-4 text-primary" />
          {t("waiting")}
        </span>
        <span className="flex items-center gap-2 tabular-nums">
          <Timer className="size-4" aria-hidden="true" />
          {t("expiresIn", { time: formatRemaining(remaining) })}
        </span>
      </div>
      <Button type="button" variant="link" onClick={onChange} className="w-fit text-sm">
        {t("changeNumber")}
      </Button>
    </section>
  );
}
