"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { BookOpen, Info, RotateCcw, Send, Sparkles, X } from "lucide-react";
import { useLocale } from "next-intl";
import { Dialog } from "radix-ui";
import { formatWait, useApiErrorMessage } from "@/components/auth/form-message";
import { TurnstileWidget, type TurnstileHandle } from "@/components/auth/turnstile-widget";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { InlineError } from "@/components/feedback/inline-error";
import { Button } from "@/components/ui/button";
import { quietLinkClassName } from "@/components/ui/text-link";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { useNumbersTranslations } from "@/i18n/numbers";
import { apiPost, isApiError } from "@/lib/auth/client";
import type { AssistantResponse, AssistantTurn, HelpHit } from "@/lib/contracts/assistant";
import { ASSISTANT_API, ASSISTANT_HISTORY_MAX, ASSISTANT_QUESTION_MAX, ASSISTANT_TURN_MAX } from "@/lib/contracts/endpoints";
import { cn } from "@/lib/utils";

// The Assistant Joutiya panel (design phase-5 D25): a side sheet (bottom sheet on phones). The AI
// disclosure (AI Act art. 50) heads the conversation and stays in view of the first question; the
// conversation lives in this component only (the API stores nothing) and the last turns go back
// with each question. When the AI is unavailable the answer is the matching help articles. Past
// the IP allowance the API asks for Turnstile (403 turnstile_required): the widget then shows.

export interface AssistantPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Turn = { id: number; role: "user"; text: string } | { id: number; role: "assistant"; response: AssistantResponse };

/** The turns the API gets back: questions and AI answers (search-only answers carry no text). */
export function historyOf(turns: readonly Turn[]): AssistantTurn[] {
  const history = turns.flatMap((turn): AssistantTurn[] => {
    if (turn.role === "user") return [{ role: "user", text: turn.text.slice(0, ASSISTANT_TURN_MAX) }];
    return turn.response.mode === "ai" ? [{ role: "assistant", text: turn.response.answer.slice(0, ASSISTANT_TURN_MAX) }] : [];
  });
  return history.slice(-ASSISTANT_HISTORY_MAX);
}

function Sources({ title, articles, onNavigate }: { title?: string; articles: readonly HelpHit[]; onNavigate: () => void }) {
  if (articles.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {title ? <p className="text-xs font-medium text-foreground-muted">{title}</p> : null}
      <ul className="flex flex-col gap-1">
        {articles.map((article) => (
          <li key={article.slug}>
            <Link
              href={`/aide/${article.slug}`}
              onClick={onNavigate}
              className={cn("flex items-start gap-2 rounded-sm py-1 text-sm font-medium text-link", quietLinkClassName)}
            >
              <BookOpen className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{article.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function AssistantPanel({ open, onOpenChange }: AssistantPanelProps) {
  // Plurals print numbers: French formatting on Tarifit pages (no Tarifit text here).
  const t = useNumbersTranslations("Help.assistant");
  const generic = useApiErrorMessage();
  const locale = useLocale() as Locale;
  const inputId = useId();
  const counterId = useId();
  const turnstile = useRef<TurnstileHandle>(null);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(0);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [empty, setEmpty] = useState(false);
  const [challenge, setChallenge] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [challengeMissing, setChallengeMissing] = useState(false);

  // Newest turn in view.
  useEffect(() => {
    const node = log.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns, pending]);

  function message(value: unknown): string {
    if (isApiError(value, "rate_limited")) return t("errors.rate_limited", { wait: formatWait(locale, value.retryAfter, t("errors.later")) });
    if (isApiError(value, "unavailable")) return t("errors.unavailable");
    if (isApiError(value, "turnstile_failed")) return t("errors.turnstile_failed");
    if (isApiError(value, "turnstile_required")) return t("challenge");
    return generic(value);
  }

  async function ask(event?: FormEvent) {
    event?.preventDefault();
    if (pending) return;
    const question = text.trim();
    if (!question) {
      setEmpty(true);
      return;
    }
    if (challenge && !token) {
      setChallengeMissing(true);
      return;
    }
    const history = historyOf(turns);
    const asked: Turn = { id: nextId.current++, role: "user", text: question };
    setTurns((current) => [...current, asked]);
    setText("");
    setError(null);
    setPending(true);
    try {
      const response = await apiPost<AssistantResponse>(ASSISTANT_API.assistant, { locale, question, history, ...(challenge && token ? { turnstileToken: token } : {}) });
      setTurns((current) => [...current, { id: nextId.current++, role: "assistant", response }]);
      setChallenge(false);
      setToken(null);
    } catch (failure) {
      // The question goes back into the field, to send again.
      setTurns((current) => current.filter((turn) => turn.id !== asked.id));
      setText(question);
      if (isApiError(failure, "turnstile_required", "turnstile_failed")) {
        setChallenge(true);
        setToken(null);
        turnstile.current?.reset();
      }
      setError(failure);
    } finally {
      setPending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter breaks the line (not while an IME composes).
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void ask();
    }
  }

  function restart() {
    setTurns([]);
    setError(null);
    setText("");
  }

  const close = () => onOpenChange(false);
  const remaining = ASSISTANT_QUESTION_MAX - text.length;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/40 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          // The question field, not the close button, takes the focus.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] min-h-[70dvh] flex-col rounded-t-xl border-t-4 border-featured bg-background shadow-2xl outline-none",
            "sm:inset-y-0 sm:start-auto sm:end-0 sm:max-h-none sm:w-[26rem] sm:rounded-none sm:border-s sm:border-t-0 sm:border-s-border",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-4 sm:data-[state=open]:slide-in-from-bottom-0",
          )}
        >
          <header className="threshold flex items-center gap-3 bg-surface-brand px-4 py-3">
            <span className="arch flex h-10 w-8 shrink-0 items-end justify-center bg-structure pb-1.5 text-structure-foreground" aria-hidden="true">
              <Sparkles className="size-4" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <Dialog.Title className="flex items-center gap-2 font-semibold">
                {t("title")}
                <span className="rounded-sm bg-structure px-1.5 py-0.5 text-xs leading-none font-semibold text-structure-foreground">{t("badge")}</span>
              </Dialog.Title>
            </div>
            {turns.length > 0 ? (
              <Button type="button" variant="ghost" size="icon" onClick={restart} aria-label={t("restart")} title={t("restart")}>
                <RotateCcw aria-hidden="true" />
              </Button>
            ) : null}
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" size="icon" aria-label={t("close")}>
                <X aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </header>

          <div ref={log} role="log" aria-label={t("conversation")} aria-live="polite" className="flex flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-4">
            {/* AI Act art. 50: the person knows from the first look that a machine answers. */}
            <div data-testid="assistant-disclosure" className="flex gap-3 rounded-md border border-border bg-surface-muted p-3 text-sm">
              <Info className="mt-0.5 size-4 shrink-0 text-structure dark:text-gold-300" aria-hidden="true" />
              <div className="flex flex-col gap-1.5">
                <p className="font-medium">{t("disclosure")}</p>
                <p className="text-foreground-muted">{t("privacy")}</p>
              </div>
            </div>

            {turns.length === 0 ? <p className="text-sm text-pretty text-foreground-muted">{t("welcome")}</p> : null}

            {turns.map((turn) =>
              turn.role === "user" ? (
                <div key={turn.id} className="flex flex-col items-end gap-1">
                  <span className="sr-only">{t("you")}</span>
                  <p dir="auto" className="max-w-[85%] rounded-lg rounded-ee-sm bg-structure px-3.5 py-2.5 text-sm whitespace-pre-line text-structure-foreground">
                    {turn.text}
                  </p>
                </div>
              ) : turn.response.mode === "ai" ? (
                <div key={turn.id} className="flex flex-col gap-3 rounded-lg rounded-es-sm border border-border bg-surface px-3.5 py-3">
                  <span className="sr-only">{t("title")}</span>
                  <p dir="auto" className="text-sm leading-6 whitespace-pre-line">
                    {turn.response.answer}
                  </p>
                  <Sources title={t("sources")} articles={turn.response.articles} onNavigate={close} />
                </div>
              ) : (
                <div key={turn.id} className="flex flex-col gap-3 rounded-lg rounded-es-sm border border-warning/40 bg-warning-surface/50 px-3.5 py-3" data-testid="assistant-degraded">
                  <div className="flex flex-col gap-0.5 text-sm">
                    <p className="font-semibold">{t("degradedTitle")}</p>
                    <p className="text-foreground-muted">{turn.response.articles.length > 0 ? t("degradedBody") : t("degradedEmpty")}</p>
                  </div>
                  <Sources articles={turn.response.articles} onNavigate={close} />
                </div>
              ),
            )}

            {pending ? (
              <p className="flex items-center gap-2 text-sm text-foreground-muted">
                <span className="flex gap-1" aria-hidden="true">
                  <span className="size-1.5 animate-pulse rounded-full bg-structure motion-reduce:animate-none" />
                  <span className="size-1.5 animate-pulse rounded-full bg-structure [animation-delay:150ms] motion-reduce:animate-none" />
                  <span className="size-1.5 animate-pulse rounded-full bg-structure [animation-delay:300ms] motion-reduce:animate-none" />
                </span>
                {t("thinking")}
              </p>
            ) : null}
          </div>

          <form onSubmit={(event) => void ask(event)} noValidate className="flex flex-col gap-3 border-t border-border bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {error ? <ErrorBanner tone={isApiError(error, "turnstile_required") ? "info" : "danger"} title={message(error)} /> : null}
            {challenge ? (
              <TurnstileWidget
                ref={turnstile}
                action="assistant"
                cData="help-assistant"
                onToken={(value) => {
                  setToken(value);
                  if (value) setChallengeMissing(false);
                }}
                error={challengeMissing ? t("challenge") : undefined}
              />
            ) : null}
            <label htmlFor={inputId} className="sr-only">
              {t("label")}
            </label>
            <div className="flex items-end gap-2">
              <textarea
                ref={input}
                id={inputId}
                dir="auto"
                rows={2}
                value={text}
                maxLength={ASSISTANT_QUESTION_MAX}
                placeholder={t("placeholder")}
                aria-describedby={remaining <= 100 ? counterId : undefined}
                aria-invalid={empty || undefined}
                onChange={(event) => {
                  setText(event.target.value);
                  if (event.target.value.trim()) setEmpty(false);
                }}
                onKeyDown={onKeyDown}
                className="max-h-36 min-h-11 flex-1 resize-none rounded-md border border-border-strong bg-background px-3 py-2.5 text-base outline-none placeholder:text-foreground-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25"
              />
              <Button type="submit" size="icon" loading={pending} aria-label={t("send")}>
                <Send className="rtl:-scale-x-100" aria-hidden="true" />
              </Button>
            </div>
            {empty ? <InlineError>{t("empty")}</InlineError> : null}
            {remaining <= 100 ? (
              <p id={counterId} className="text-end text-xs text-foreground-muted tabular-nums">
                {t("remaining", { count: remaining })}
              </p>
            ) : null}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
