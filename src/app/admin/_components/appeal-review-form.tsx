"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { inputClassName } from "@/components/ui/input";
import { DETAILS_MAX, DETAILS_MIN, decisionTemplate, type DecisionTargetType, type DecisionTemplateId } from "@/config/decision-templates";
import { APPEAL_NOTE_MAX, APPEAL_NOTE_MIN, type ReviewAppealRequest, type ReviewAppealResponse } from "@/lib/decisions/contracts";
import { cn } from "@/lib/utils";
import { ADMIN_API, adminFetch, errorMessage } from "./api-client";
import { templateAllowed, templateGroups, type StaffRole } from "./decide-state";

const MESSAGES: Record<string, string> = {
  same_reviewer: "Vous avez pris cette décision : un autre modérateur doit la réexaminer.",
  conflict: "Ce recours n'est plus ouvert : rechargez la page.",
  invalid_body: "Réexamen refusé : vérifiez la réponse et, pour une annulation, la mesure à prendre.",
  sanction_not_allowed: "Mesure refusée : un modérateur ne ferme un compte que pour confirmer un signalement P0.",
  rate_limited: "Trop de décisions en peu de temps. Réessayez dans quelques minutes.",
};

interface AppealReviewFormProps {
  decisionId: string;
  /** The appealed decision restricted someone (a reversal undoes it); else a dismissal reversed takes a measure now. */
  restrictive: boolean;
  targetType: DecisionTargetType | null;
  role: StaffRole;
  /** The admin reviews his own decision (D16): allowed, journaled. */
  selfReview: boolean;
}

/** The review of an appeal (art. 20 DSA, D16): upheld or reversed, with the answer sent to the appellant. */
export function AppealReviewForm({ decisionId, restrictive, targetType, role, selfReview }: AppealReviewFormProps) {
  const router = useRouter();
  const groupId = useId();
  const [outcome, setOutcome] = useState<ReviewAppealRequest["outcome"]>("upheld");
  const [note, setNote] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [details, setDetails] = useState("");
  const [problems, setProblems] = useState<{ note?: string; template?: string; details?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const measure = outcome === "reversed" && !restrictive && targetType !== null;
  const measures = targetType ? templateGroups(targetType).measures.filter((template) => templateAllowed(template, { role, priorities: [] })) : [];
  const template = templateId ? decisionTemplate(templateId) : undefined;

  function validate(): ReviewAppealRequest | null {
    const found: typeof problems = {};
    const text = note.trim();
    if (text.length < APPEAL_NOTE_MIN || text.length > APPEAL_NOTE_MAX) found.note = `Motivez la réponse en ${APPEAL_NOTE_MIN} à ${APPEAL_NOTE_MAX} caractères.`;
    if (measure && !template) found.template = "Choisissez la mesure à prendre.";
    const extra = details.trim();
    if (measure && template?.detailsRequired && extra.length < DETAILS_MIN) found.details = `Ce modèle demande une précision d'au moins ${DETAILS_MIN} caractères.`;
    setProblems(found);
    if (Object.keys(found).length > 0) return null;
    return {
      outcome,
      note: text,
      ...(measure && template ? { templateId: template.id as DecisionTemplateId, ...(extra ? { details: extra } : {}) } : {}),
    };
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const body = validate();
    if (!body) return;
    setLoading(true);
    try {
      await adminFetch<ReviewAppealResponse>(`${ADMIN_API.appeals}/${encodeURIComponent(decisionId)}`, { method: "POST", csrf: true, body });
      toast.success(outcome === "upheld" ? "Décision maintenue" : "Décision annulée", { description: "L'auteur du recours reçoit votre réponse." });
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
    } finally {
      setLoading(false);
    }
  }

  const choices = [
    { value: "upheld" as const, label: "Maintenir la décision", description: "Le recours est rejeté." },
    {
      value: "reversed" as const,
      label: "Annuler la décision",
      description: restrictive ? "Le contenu est rétabli, la sanction levée et un niveau retiré de l'échelle." : "La mesure choisie est prise maintenant ; les signalements d'origine deviennent fondés.",
    },
  ];

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <h2 id={groupId} className="text-lg font-semibold">
        Réexamen
      </h2>
      {selfReview ? (
        <ErrorBanner tone="warning" title="Réexamen de votre propre décision">
          Autorisé pour un admin : ce réexamen est journalisé (appeal.self_review) et marqué sur le recours.
        </ErrorBanner>
      ) : null}
      <div role="radiogroup" aria-labelledby={groupId} className="grid gap-2">
        {choices.map((choice) => (
          <label
            key={choice.value}
            className={cn(
              "flex cursor-pointer gap-3 rounded-md border p-3 transition-colors",
              outcome === choice.value ? "border-structure bg-structure/5" : "border-border hover:border-border-strong",
            )}
          >
            <input type="radio" name="outcome" value={choice.value} checked={outcome === choice.value} onChange={() => setOutcome(choice.value)} className="mt-1 size-4 accent-current" />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{choice.label}</span>
              <span className="text-sm text-foreground-muted">{choice.description}</span>
            </span>
          </label>
        ))}
      </div>
      {measure ? (
        <>
          <Field label="Mesure à prendre" required error={problems.template}>
            <select name="template" value={templateId} onChange={(event) => setTemplateId(event.target.value)} className={inputClassName}>
              <option value="">Choisir un modèle</option>
              {measures.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Précision du modérateur" required={template?.detailsRequired === true} error={problems.details} hint="Citée telle quelle dans l'exposé des motifs.">
            <textarea name="details" rows={2} maxLength={DETAILS_MAX} value={details} onChange={(event) => setDetails(event.target.value)} className={cn(inputClassName, "h-auto min-h-16 py-2")} />
          </Field>
        </>
      ) : null}
      <Field label="Réponse motivée" required error={problems.note} hint="Envoyée à l'auteur du recours avec l'issue.">
        <textarea name="note" rows={4} maxLength={APPEAL_NOTE_MAX} value={note} onChange={(event) => setNote(event.target.value)} className={cn(inputClassName, "h-auto min-h-24 py-2")} />
      </Field>
      {error ? <ErrorBanner title={error} /> : null}
      <Button type="submit" variant={outcome === "reversed" ? "primary" : "structure"} loading={loading}>
        {outcome === "upheld" ? "Maintenir la décision" : "Annuler la décision"}
      </Button>
    </form>
  );
}
