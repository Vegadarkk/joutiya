"use client";

import { useState, type FormEvent } from "react";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { inputClassName } from "@/components/ui/input";
import type { StaffConversationView } from "@/lib/decisions/contracts";
import { cn } from "@/lib/utils";
import { formatDateTime } from "../_lib/moderation-format";
import { ADMIN_API, adminFetch, errorMessage } from "./api-client";

export const REASON_MIN = 10;
export const REASON_MAX = 300;

const MESSAGES: Record<string, string> = {
  forbidden: "Lecture refusée : aucun signalement ni demande d'autorité ne vise cette conversation.",
  not_found: "Cette conversation n'existe plus.",
  invalid_body: `Motif : ${REASON_MIN} à ${REASON_MAX} caractères.`,
  rate_limited: "Trop de conversations ouvertes en peu de temps. Réessayez plus tard.",
};

const FROM_LABEL = { buyer: "Acheteur", seller: "Vendeur", system: "Aalan" } as const;

/** The transcript, oldest first (the API answers newest first), with the evidence of masked or hidden messages. */
function Transcript({ conversation }: { conversation: StaffConversationView }) {
  const messages = [...conversation.messages].reverse();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          Annonce « <span dir="auto">{conversation.listingTitle}</span> » ({conversation.listingId}). Acheteur <span dir="auto">{conversation.buyer.name}</span>, vendeur{" "}
          <span dir="auto">{conversation.seller.name}</span>.
        </span>
        {conversation.status === "frozen" ? <Badge variant="warning">Gelée (autorité)</Badge> : null}
      </div>
      <p className="text-sm text-foreground-muted">
        Accès au titre de {conversation.access.reportIds.length > 0 ? `${conversation.access.reportIds.length} signalement(s)` : ""}
        {conversation.access.reportIds.length > 0 && conversation.access.authorityHolds.length > 0 ? " et de " : ""}
        {conversation.access.authorityHolds.length > 0 ? `${conversation.access.authorityHolds.length} demande(s) d'autorité` : ""}. {messages.length} message(s), les 200 plus récents au plus.
      </p>
      <ol aria-label="Messages, du plus ancien au plus récent" className="flex flex-col gap-2">
        {messages.map((message) => {
          const evidence = conversation.evidence[message.id];
          return (
            <li
              key={message.id}
              className={cn(
                "flex max-w-[85%] flex-col gap-1 rounded-lg border p-3 text-sm",
                message.from === "seller" ? "self-end border-border bg-surface-muted" : message.from === "system" ? "self-center border-dashed border-border" : "self-start border-border bg-surface",
                message.reported && "border-danger ring-1 ring-danger/40",
              )}
            >
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-foreground-muted">
                <span className="font-medium text-foreground">{FROM_LABEL[message.from]}</span>
                <time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time>
                {message.reported ? <Badge variant="danger">Signalé</Badge> : null}
                {message.hidden ? <Badge variant="warning">Masqué</Badge> : null}
                {message.flags.length > 0 ? <Badge variant="neutral">{message.flags.join(", ")}</Badge> : null}
              </span>
              <p dir="auto" className="text-pretty whitespace-pre-line">
                {message.text}
              </p>
              {evidence ? (
                <p dir="auto" className="rounded-md bg-warning-surface p-2 whitespace-pre-line">
                  <span className="block text-xs font-medium">Texte d&apos;origine ({evidence.reason === "hidden" ? "message masqué" : "liens masqués"})</span>
                  {evidence.text}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** D18: the whole conversation opens only with a reason (10-300 characters), journaled with it. */
export function ConversationViewer({ cid }: { cid: string }) {
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [conversation, setConversation] = useState<StaffConversationView | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const text = reason.trim();
    if (text.length < REASON_MIN || text.length > REASON_MAX) {
      setProblem(`Indiquez pourquoi vous ouvrez cette conversation (${REASON_MIN} à ${REASON_MAX} caractères).`);
      return;
    }
    setProblem(null);
    setLoading(true);
    try {
      const result = await adminFetch<{ conversation: StaffConversationView }>(`${ADMIN_API.conversations}/${encodeURIComponent(cid)}?reason=${encodeURIComponent(text)}`, { method: "GET" });
      setConversation(result?.conversation ?? null);
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
    } finally {
      setLoading(false);
    }
  }

  if (conversation) return <Transcript conversation={conversation} />;
  return (
    <form onSubmit={onSubmit} noValidate className="flex max-w-xl flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <Field label="Motif de la lecture" required error={problem} hint="Journalisé avec votre nom, l'heure et cette conversation. Exemple : examen du signalement d'un message d'arnaque.">
        <textarea name="reason" rows={3} maxLength={REASON_MAX} value={reason} onChange={(event) => setReason(event.target.value)} className={cn(inputClassName, "h-auto min-h-20 py-2")} />
      </Field>
      {error ? <ErrorBanner title={error} /> : null}
      <Button type="submit" variant="structure" loading={loading} className="self-start">
        Ouvrir la conversation
      </Button>
    </form>
  );
}
