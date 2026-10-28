"use client";

import { useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { SendHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { inputClassName } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MESSAGE_TEXT_MAX } from "@/lib/contracts/endpoints";
import { cn } from "@/lib/utils";

// The reply field of a thread: grows with its text up to a few lines; Enter sends on a computer
// (Shift + Enter for a new line), the button everywhere. The text leaves the field at once and
// comes back if the server refuses it. `error` is the last refusal, translated by the thread.

/** Problem that keeps the text from leaving: blank, or the markers reserved for the server. */
export function composerProblem(text: string): "empty" | "reserved" | null {
  const trimmed = text.trim();
  if (!trimmed) return "empty";
  return /[⟦⟧]/.test(trimmed) ? "reserved" : null;
}

/** Enter sends on a device with a fine pointer; never while an input method composes a word. */
export function sendsOnEnter(event: Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"> & { isComposing: boolean }, finePointer: boolean): boolean {
  if (event.key !== "Enter" || event.isComposing || event.shiftKey || event.altKey) return false;
  return finePointer || event.ctrlKey || event.metaKey;
}

export interface ComposerProps {
  /** Sends the trimmed text; false when the server refused it (the text comes back). */
  onSend: (text: string) => Promise<boolean>;
  error?: string | null;
  onTyping?: () => void;
  /** Before the field: the thread's appointment button. */
  leading?: ReactNode;
}

export function Composer({ onSend, error, onTyping, leading }: ComposerProps) {
  const t = useTranslations("Messaging.composer");
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<"reserved" | null>(null);
  const remaining = MESSAGE_TEXT_MAX - text.length;

  async function submit() {
    if (busy) return;
    const found = composerProblem(text);
    if (found === "empty") return;
    if (found === "reserved") {
      setProblem("reserved");
      return;
    }
    const value = text.trim();
    setText("");
    setBusy(true);
    const sent = await onSend(value);
    setBusy(false);
    // Refused: the text comes back unless something new was typed meanwhile.
    if (!sent) setText((current) => (current ? current : value));
    field.current?.focus();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const finePointer = typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches;
    if (!sendsOnEnter({ ...event, isComposing: event.nativeEvent.isComposing }, finePointer)) return;
    event.preventDefault();
    void submit();
  }

  const describedBy = [problem ? `${id}-problem` : null, error ? `${id}-error` : null, remaining <= 200 ? `${id}-count` : null].filter(Boolean).join(" ") || undefined;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2 border-t border-border bg-surface px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:px-5" data-testid="composer">
      {error ? (
        <InlineError id={`${id}-error`} className="px-1">
          {error}
        </InlineError>
      ) : null}
      {problem ? (
        <InlineError id={`${id}-problem`} className="px-1">
          {t("reserved")}
        </InlineError>
      ) : null}
      <div className="flex items-end gap-2">
        {leading}
        <label htmlFor={`${id}-text`} className="sr-only">
          {t("label")}
        </label>
        <textarea
          ref={field}
          id={`${id}-text`}
          rows={1}
          dir="auto"
          value={text}
          maxLength={MESSAGE_TEXT_MAX}
          placeholder={t("placeholder")}
          enterKeyHint="send"
          aria-invalid={problem ? true : undefined}
          aria-describedby={describedBy}
          onKeyDown={onKeyDown}
          onChange={(event) => {
            setText(event.target.value);
            if (problem) setProblem(null);
            onTyping?.();
          }}
          className={cn(inputClassName, "field-sizing-content h-auto max-h-40 min-h-11 resize-none rounded-[1.375rem] px-4 py-2.5 leading-normal")}
        />
        <Button type="submit" size="icon" aria-label={t("send")} disabled={!text.trim()} loading={busy} className="rounded-full">
          {busy ? null : <SendHorizontal className="rtl:-scale-x-100" aria-hidden="true" />}
        </Button>
      </div>
      {remaining <= 200 ? (
        <p id={`${id}-count`} className="px-1 text-end text-xs text-foreground-muted tabular-nums">
          {t("remaining", { count: remaining })}
        </p>
      ) : null}
    </form>
  );
}
