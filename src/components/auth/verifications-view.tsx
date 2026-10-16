"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { BadgeCheck, Check, Copy, MessageCircle, Timer, TriangleAlert } from "lucide-react";
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
import { isolateLtr } from "@/lib/i18n/bidi";
import { FormMessage, useApiErrorMessage, useFieldMessage } from "./form-message";
import { displayMoroccanPhone, phoneArgument } from "./phone-display";
import { StatusPanel } from "./status-panel";

// /verifications: WhatsApp phone verification (§6). The person sends the code from their own
// WhatsApp to Joutiya's number; the webhook sets the badge; this page polls the status.

/** Status poll while a code is pending: 6 calls a minute, well under phone.status.uid (400/h). */
const POLL_MS = 10_000;

type State =
  | { kind: "loading" }
  | { kind: "failed"; error: unknown }
  | { kind: "idle" }
  | { kind: "pendingUnknown"; phone: string | null }
  | { kind: "pending"; phone: string; code: string; waLink: string; number: string; expiresAt: number }
  | { kind: "verified"; phone: string | null }
  | { kind: "expired"; phone: string | null }
  | { kind: "unavailable" };

type PhoneForm = z.input<typeof phoneStartSchema>;
type PhoneInput = z.output<typeof phoneStartSchema>;

function fromStatus(status: PhoneStatusResponse): State {
  if (status.status === "verified") return { kind: "verified", phone: status.phone };
  if (status.status === "pending") return { kind: "pendingUnknown", phone: status.phone };
  if (status.status === "expired") return { kind: "expired", phone: status.phone };
  // "none": nothing verified or pending, including a number that was since verified by another account.
  return { kind: "idle" };
}

export function VerificationsView() {
  const t = useTranslations("Auth.verifications");
  const apiMessage = useApiErrorMessage();
  const [state, setState] = useState<State>({ kind: "loading" });
  const started = useRef(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState(fromStatus(await apiGet<PhoneStatusResponse>(AUTH_API.phoneStatus)));
    } catch (error) {
      setState(isApiError(error, "unavailable") ? { kind: "unavailable" } : { kind: "failed", error });
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

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
      ) : state.kind === "failed" ? (
        <FormMessage
          error={state.error}
          title={t("loadFailedTitle")}
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              {t("retry")}
            </Button>
          }
        >
          {apiMessage(state.error)}
        </FormMessage>
      ) : state.kind === "unavailable" ? (
        <ErrorBanner tone="info" title={t("unavailable")} action={<BackToSettings />} />
      ) : state.kind === "verified" ? (
        <StatusPanel icon={BadgeCheck} title={t("verifiedTitle")} extra={<VerifiedBadge />} actions={<BackToSettings />}>
          {t("verifiedBody", { phone: phoneArgument(state.phone) })}
        </StatusPanel>
      ) : state.kind === "pending" ? (
        <PendingCode
          state={state}
          onExpired={() => setState({ kind: "expired", phone: state.phone })}
          onVerified={() => setState({ kind: "verified", phone: state.phone })}
          onReset={() => setState({ kind: "idle" })}
        />
      ) : (
        <div className="flex flex-col gap-6">
          {state.kind === "expired" ? (
            <ErrorBanner tone="warning" title={t("expiredTitle")}>
              {t("expiredBody")}
            </ErrorBanner>
          ) : state.kind === "pendingUnknown" ? (
            <ErrorBanner tone="info" title={t("pendingTitle")}>
              {t("pendingBody", { phone: phoneArgument(state.phone) })}
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
      // 409 here only means "this account already has a verified number" (a number held by another
      // account is transferred by the proof of possession, not refused).
      else if (isApiError(error, "conflict")) setError("phone", { type: "server", message: t("alreadyVerified") }, { shouldFocus: true });
      else if (isApiError(error, "phone_invalid", "phone_not_mobile")) setError("phone", { type: "server", message: apiMessage(error) }, { shouldFocus: true });
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

export function PendingCode({
  state,
  onExpired,
  onVerified,
  onReset,
}: {
  state: Extract<State, { kind: "pending" }>;
  onExpired: () => void;
  onVerified: () => void;
  /** Back to the empty form: the person changes number, or the server no longer knows the request. */
  onReset: () => void;
}) {
  const t = useTranslations("Auth.verifications");
  const heading = useRef<HTMLHeadingElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  // Polling stopped on a 429: a reload asks again.
  const [pollStopped, setPollStopped] = useState(false);
  const remaining = state.expiresAt - now;

  // The code replaced the form: focus says so.
  useEffect(() => {
    heading.current?.focus();
  }, []);

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
    if (pollStopped) return;
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
        } else if (status.status === "none") {
          onReset();
        }
      } catch (error) {
        if (!active) return;
        // Rate limited: stop instead of hammering; anything else is transient and the next tick asks again.
        if (isApiError(error, "rate_limited")) setPollStopped(true);
      }
    };
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [onVerified, onExpired, onReset, pollStopped]);

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
    <section aria-labelledby="phone-code-title" className="flex flex-col gap-6 rounded-lg border border-border bg-surface p-6">
      <div className="flex flex-col gap-1">
        <h2 id="phone-code-title" ref={heading} tabIndex={-1} className="rounded-sm text-lg font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/25">
          {t("codeTitle")}
        </h2>
        <p className="text-foreground-muted text-pretty">{t("codeBody", { phone: phoneArgument(state.phone) })}</p>
      </div>
      <div className="arch flex flex-col items-center gap-3 rounded-b-lg bg-surface-brand px-6 pb-6 pt-10 text-center">
        <span className="text-sm text-foreground-muted">{t("codeLabel")}</span>
        <p dir="ltr" className="text-4xl font-semibold tracking-[0.35em] tabular-nums text-foreground ps-[0.35em]">
          {state.code}
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={copyCode} className="h-11">
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? t("copied") : t("copyCode")}
        </Button>
      </div>
      <div className="flex flex-col gap-3">
        {/* Brand green, token-based; the speech-bubble glyph carries the WhatsApp identity. */}
        <Button asChild size="lg" variant="structure" className="w-full">
          <a href={state.waLink} target="_blank" rel="noopener noreferrer">
            <MessageCircle aria-hidden="true" />
            {t("openWhatsApp")}
          </a>
        </Button>
        <p className="text-center text-sm text-foreground-muted">
          {t("joutiyaNumber")}{" "}
          <span dir="ltr" className="whitespace-nowrap font-medium text-foreground">
            {displayMoroccanPhone(`+${state.number.replace(/^\+/, "")}`)}
          </span>
        </p>
      </div>
      <div className="flex flex-col gap-2 border-t border-border pt-4 text-sm text-foreground-muted sm:flex-row sm:items-center sm:justify-between">
        {/* The only live region: one line, which changes once (waiting -> paused). */}
        <span role="status" className={pollStopped ? "flex items-start gap-2 text-warning" : "flex items-center gap-2"}>
          {pollStopped ? <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : <Spinner className="size-4 text-primary" />}
          {pollStopped ? t("pollStopped") : t("waiting")}
        </span>
        {/* Ticks every second: kept out of the accessibility tree (the expiry itself is announced when it happens). */}
        <span aria-hidden="true" className="flex shrink-0 items-center gap-2 tabular-nums">
          <Timer className="size-4" />
          {t("expiresIn", { time: isolateLtr(formatRemaining(remaining)) })}
        </span>
      </div>
      <Button type="button" variant="link" onClick={onReset} className="w-fit text-sm">
        {t("changeNumber")}
      </Button>
    </section>
  );
}
