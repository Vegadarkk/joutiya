"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { inputClassName } from "@/components/ui/input";
import {
  DECISION_DETAILS_MIN,
  DECISION_TEXT_MAX,
  REJECT_REASON_CODES,
  REJECT_REASONS,
  type ModerationDecisionRequest,
  type ModerationDecisionResponse,
  type RejectReasonCode,
} from "@/lib/moderation/decisions";
import { cn } from "@/lib/utils";
import { adminFetch, errorMessage } from "./api-client";

export const MODERATION_API = "/api/admin/moderation";

const MESSAGES: Record<string, string> = {
  conflict: "Cette annonce a changé depuis l'ouverture de la page (modification du vendeur ou décision d'un autre modérateur). Rechargez la page avant de décider.",
  not_found: "Cette annonce n'existe plus.",
  invalid_body: "Choisissez un motif. « Autre motif » demande une précision d'au moins 10 caractères.",
  forbidden: "Réservé aux modérateurs et aux admins.",
  rate_limited: "Trop de décisions en peu de temps. Réessayez dans quelques minutes.",
};

type Choice = "approve" | "reject";

const CHOICES: { value: Choice; label: string; description: string }[] = [
  { value: "approve", label: "Publier", description: "L'annonce est mise en ligne pour la durée normale ; le vendeur est prévenu." },
  { value: "reject", label: "Refuser", description: "Le vendeur reçoit le motif et peut corriger puis soumettre à nouveau son annonce." },
];

interface ModerationDecisionFormProps {
  listingId: string;
  /** Version the page was rendered with: a change since answers 409. */
  version: number;
}

/** Approve or reject a held listing; one explicit submit whose label names the outcome. */
export function ModerationDecisionForm({ listingId, version }: ModerationDecisionFormProps) {
  const router = useRouter();
  const groupId = useId();
  const [choice, setChoice] = useState<Choice>("approve");
  const [reason, setReason] = useState<RejectReasonCode | "">("");
  const [details, setDetails] = useState("");
  const [note, setNote] = useState("");
  const [fieldError, setFieldError] = useState<{ reason?: string; details?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function validate(): ModerationDecisionRequest | null {
    if (choice === "approve") return { action: "approve", version, ...(note.trim() ? { note: note.trim() } : {}) };
    if (!reason) {
      setFieldError({ reason: "Choisissez le motif du refus." });
      return null;
    }
    const text = details.trim();
    if (REJECT_REASONS[reason].detailsRequired && text.length < DECISION_DETAILS_MIN) {
      setFieldError({ details: `Expliquez le motif en au moins ${DECISION_DETAILS_MIN} caractères.` });
      return null;
    }
    return { action: "reject", version, reason, ...(text ? { details: text } : {}) };
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldError({});
    const body = validate();
    if (!body) return;
    setLoading(true);
    try {
      await adminFetch<ModerationDecisionResponse>(`${MODERATION_API}/${encodeURIComponent(listingId)}`, { method: "POST", csrf: true, body });
      toast.success(body.action === "approve" ? "Annonce publiée" : "Annonce refusée", { description: "Le vendeur est prévenu par e-mail." });
      router.push("/moderation");
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <h2 id={groupId} className="text-lg font-semibold">
        Décision
      </h2>
      <div role="radiogroup" aria-labelledby={groupId} className="grid gap-2">
        {CHOICES.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex cursor-pointer gap-3 rounded-md border p-3 transition-colors",
              choice === option.value ? (option.value === "approve" ? "border-structure bg-structure/5" : "border-danger bg-danger-surface") : "border-border hover:border-border-strong",
            )}
          >
            <input type="radio" name="decision" value={option.value} checked={choice === option.value} onChange={() => setChoice(option.value)} className="mt-1 size-4 accent-current" />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{option.label}</span>
              <span className="text-sm text-foreground-muted">{option.description}</span>
            </span>
          </label>
        ))}
      </div>

      {choice === "approve" ? (
        <Field label="Note interne" hint="Gardée dans le dossier de la décision, jamais envoyée au vendeur.">
          <textarea name="note" rows={2} maxLength={DECISION_TEXT_MAX} value={note} onChange={(event) => setNote(event.target.value)} className={cn(inputClassName, "h-auto min-h-16 py-2")} />
        </Field>
      ) : (
        <>
          <Field label="Motif" required error={fieldError.reason}>
            <select name="reason" value={reason} onChange={(event) => setReason(event.target.value as RejectReasonCode | "")} className={inputClassName}>
              <option value="">Choisir un motif</option>
              {REJECT_REASON_CODES.map((code) => (
                <option key={code} value={code}>
                  {REJECT_REASONS[code].label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Précision pour le vendeur"
            required={reason !== "" && REJECT_REASONS[reason].detailsRequired === true}
            error={fieldError.details}
            hint="Envoyée telle quelle au vendeur avec le motif. Aucune donnée personnelle."
          >
            <textarea name="details" rows={3} maxLength={DECISION_TEXT_MAX} value={details} onChange={(event) => setDetails(event.target.value)} className={cn(inputClassName, "h-auto min-h-20 py-2")} />
          </Field>
        </>
      )}

      {error ? <ErrorBanner title={error} /> : null}
      <Button type="submit" variant={choice === "approve" ? "structure" : "danger"} loading={loading}>
        {choice === "approve" ? "Publier l'annonce" : "Refuser l'annonce"}
      </Button>
    </form>
  );
}
