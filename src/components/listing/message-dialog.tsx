"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { LockKeyhole, Send } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Dialog } from "radix-ui";
import { formatWait, FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { TurnstileWidget, type TurnstileHandle } from "@/components/auth/turnstile-widget";
import { InlineError } from "@/components/feedback/inline-error";
import { Textarea } from "@/components/post/controls/textarea";
import { Button } from "@/components/ui/button";
import { Link, useRouter } from "@/i18n/navigation";
import { ApiError, refreshSession } from "@/lib/auth/client";
import { MESSAGE_TEXT_MAX } from "@/lib/contracts/endpoints";
import { isolate } from "@/lib/i18n/bidi";
import { startConversation } from "@/lib/messaging/client";
import { cn } from "@/lib/utils";

// First message about a listing (design phase-5 D4, D8): loaded on demand by the contact bar. The
// text, a Turnstile check (always on the first message of a conversation, AF §6), then POST
// /api/conversations and the thread page. A conversation that already exists takes the message too
// (the server answers its cid), so the buyer lands in it either way. Phone checks play no part.
// An adults-only listing (decorative koumiyas) adds the buyer's 18+ confirmation, required.

/** Codes with their own wording here; the rest take the generic API message. */
export const COMPOSE_ERROR_KEYS = ["listing_unavailable", "not_found", "conversation_blocked", "account_suspended", "rate_limited", "quota_exhausted", "adult_confirmation_required"] as const;
export type ComposeErrorKey = (typeof COMPOSE_ERROR_KEYS)[number];

export function composeErrorKey(error: unknown): ComposeErrorKey | null {
  const code = error instanceof ApiError ? error.code : null;
  return code && (COMPOSE_ERROR_KEYS as readonly string[]).includes(code) ? (code as ComposeErrorKey) : null;
}

/** Validation of the text before sending: null when it can go. */
export function composeProblem(text: string): "empty" | "reserved" | null {
  const trimmed = text.trim();
  if (!trimmed) return "empty";
  return /[⟦⟧]/.test(trimmed) ? "reserved" : null;
}

export interface MessageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  listingId: string;
  listingTitle?: string;
  sellerName?: string;
  /** Adults-only listing: the buyer confirms being 18 or older before the first message. */
  adultsOnly?: boolean;
  /** The session ended meanwhile: the bar shows its sign-in prompt. */
  onSignedOut: () => void;
}

export function MessageDialog({ open, onOpenChange, listingId, listingTitle, sellerName, adultsOnly = false, onSignedOut }: MessageDialogProps) {
  const t = useTranslations("ListingPage.contact.compose");
  const generic = useApiErrorMessage();
  const locale = useLocale();
  const router = useRouter();
  const counterId = useId();
  const turnstile = useRef<TurnstileHandle>(null);
  const [text, setText] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<"empty" | "reserved" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [challengeMissing, setChallengeMissing] = useState(false);
  const [adult, setAdult] = useState(false);
  const [adultMissing, setAdultMissing] = useState(false);

  const remaining = MESSAGE_TEXT_MAX - text.length;

  function message(caught: unknown): string {
    const key = composeErrorKey(caught);
    if (key === "rate_limited") return t("errors.rate_limited", { wait: formatWait(locale, caught instanceof ApiError ? caught.retryAfter : undefined, t("errors.later")) });
    return key ? t(`errors.${key}`) : generic(caught);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const found = composeProblem(text);
    setProblem(found);
    if (adultsOnly && !adult) setAdultMissing(true);
    if (found || (adultsOnly && !adult)) return;
    if (!token) {
      setChallengeMissing(true);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { cid } = await startConversation({ listingId, text: text.trim(), turnstileToken: token, ...(adultsOnly ? { adultConfirmed: true as const } : {}) });
      router.push(`/messages/${cid}`);
    } catch (caught) {
      setPending(false);
      // A token is single use: a fresh one for the next attempt, whatever went wrong.
      setToken(null);
      turnstile.current?.reset();
      if (caught instanceof ApiError && caught.code === "unauthenticated") {
        await refreshSession();
        onSignedOut();
        return;
      }
      setError(caught);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          data-testid="message-dialog"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col overflow-y-auto rounded-t-lg border border-border bg-surface shadow-xl shadow-bab-950/20 outline-none",
            "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg rtl:sm:translate-x-1/2",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-5 p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <div className="flex flex-col gap-1.5">
              <Dialog.Title className="text-xl font-semibold text-balance">{sellerName ? t("title", { name: isolate(sellerName) }) : t("titleFallback")}</Dialog.Title>
              {listingTitle ? <Dialog.Description className="text-foreground-muted text-pretty">{t("about", { title: isolate(listingTitle) })}</Dialog.Description> : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${counterId}-text`} className="text-sm font-medium">
                {t("label")}
              </label>
              <Textarea
                id={`${counterId}-text`}
                rows={4}
                dir="auto"
                value={text}
                maxLength={MESSAGE_TEXT_MAX}
                placeholder={t("placeholder")}
                aria-invalid={problem ? true : undefined}
                aria-describedby={problem ? `${counterId}-problem` : remaining <= 200 ? counterId : undefined}
                className="min-h-28 resize-none"
                onChange={(event) => {
                  setText(event.target.value);
                  if (problem) setProblem(null);
                }}
              />
              {problem ? (
                <InlineError id={`${counterId}-problem`}>{t(problem)}</InlineError>
              ) : remaining <= 200 ? (
                <p id={counterId} className="text-end text-xs text-foreground-muted tabular-nums">
                  {t("remaining", { count: remaining })}
                </p>
              ) : null}
            </div>

            {adultsOnly ? (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`${counterId}-adult`} className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
                  <input
                    id={`${counterId}-adult`}
                    type="checkbox"
                    checked={adult}
                    aria-required="true"
                    aria-invalid={adultMissing && !adult ? true : undefined}
                    aria-describedby={adultMissing && !adult ? `${counterId}-adult-error` : undefined}
                    onChange={(event) => {
                      setAdult(event.target.checked);
                      if (event.target.checked) setAdultMissing(false);
                    }}
                    className="mt-1 size-5 shrink-0 cursor-pointer rounded-sm border-border-strong accent-primary"
                  />
                  <span className="text-pretty">{t("adultConfirm")}</span>
                </label>
                {adultMissing && !adult ? (
                  <InlineError id={`${counterId}-adult-error`} className="ps-8">
                    {t("adultMissing")}
                  </InlineError>
                ) : null}
              </div>
            ) : null}

            <p className="flex items-start gap-2 text-sm text-foreground-muted text-pretty">
              <LockKeyhole className="mt-0.5 size-4 shrink-0 text-structure dark:text-gold-300" aria-hidden="true" />
              <span>
                {t("privacy")} {t("safety")}{" "}
                {t.rich("scanned", {
                  link: (chunks) => (
                    <Link href="/legal/confidentialite#finalites-3" target="_blank" rel="noopener" className="font-medium text-link underline underline-offset-2">
                      {chunks}
                    </Link>
                  ),
                })}
              </span>
            </p>

            <TurnstileWidget
              ref={turnstile}
              action="message"
              cData="listing-message"
              onToken={(value) => {
                setToken(value);
                if (value) setChallengeMissing(false);
              }}
              error={challengeMissing ? t("challenge") : undefined}
            />

            {error ? <FormMessage error={error} title={message(error)} /> : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Dialog.Close asChild>
                <Button type="button" variant="outline" disabled={pending}>
                  {t("cancel")}
                </Button>
              </Dialog.Close>
              <Button type="submit" loading={pending}>
                <Send className="rtl:-scale-x-100" aria-hidden="true" />
                {t("send")}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
