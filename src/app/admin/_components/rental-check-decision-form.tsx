"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { inputClassName } from "@/components/ui/input";
import { RENTAL_CHECK_REASON_MIN, type RentalCheckDecisionInput, type RentalCheckDecisionResponse } from "@/lib/contracts/pro";
import { RENTAL_CHECK_REASON_MAX } from "@/lib/pro/profile-schema";
import { cn } from "@/lib/utils";
import { adminFetch, errorMessage } from "./api-client";

// Decision on a car rental agency's licence document the AI check left in doubt (decision 5):
// verify (the storefront shows « agrément contrôlé sur document ») or refuse with a reason the
// agency reads in its settings. `submittedAt` pins the document the page showed.

const MESSAGES: Record<string, string> = {
  conflict: "Le document a changé depuis l'ouverture de la page (nouvel envoi ou décision d'un autre modérateur). Rechargez la page.",
  not_found: "Cette boutique n'existe plus.",
  invalid_body: `Le motif doit compter de ${RENTAL_CHECK_REASON_MIN} à ${RENTAL_CHECK_REASON_MAX} caractères.`,
  forbidden: "Réservé aux modérateurs et aux admins.",
  rate_limited: "Trop de décisions en peu de temps. Réessayez dans quelques minutes.",
};

type Choice = RentalCheckDecisionInput["action"];

export function RentalCheckDecisionForm({ proId, submittedAt }: { proId: string; submittedAt: string }) {
  const router = useRouter();
  const groupId = useId();
  const [choice, setChoice] = useState<Choice>("verify");
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setReasonError(undefined);
    const text = reason.trim();
    if (choice === "reject" && text.length < RENTAL_CHECK_REASON_MIN) {
      setReasonError(`Expliquez le motif en au moins ${RENTAL_CHECK_REASON_MIN} caractères.`);
      return;
    }
    const body: RentalCheckDecisionInput = choice === "verify" ? { action: "verify", submittedAt } : { action: "reject", reason: text, submittedAt };
    setLoading(true);
    try {
      await adminFetch<RentalCheckDecisionResponse>(`/api/admin/pros/${encodeURIComponent(proId)}/rental-check`, { method: "POST", csrf: true, body });
      toast.success(choice === "verify" ? "Agrément contrôlé" : "Document refusé", {
        description: choice === "verify" ? "La vitrine affiche « agrément contrôlé sur document »." : "L'agence lit le motif dans ses réglages.",
      });
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
    } finally {
      setLoading(false);
    }
  }

  const choices: { value: Choice; label: string; description: string }[] = [
    { value: "verify", label: "Agrément concordant", description: "Numéro, bénéficiaire et date concordent, aucun signe de retouche : la vitrine porte la mention." },
    { value: "reject", label: "Refuser le document", description: "L'agence voit le motif et peut envoyer un autre document. Sa référence reste « déclarée »." },
  ];

  return (
    <form onSubmit={onSubmit} noValidate data-testid="rental-check-decision" className="flex flex-col gap-4 border-t border-border pt-4">
      <p id={groupId} className="text-sm font-medium">
        Décision sur le document
      </p>
      <div role="radiogroup" aria-labelledby={groupId} className="grid gap-2">
        {choices.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex cursor-pointer gap-3 rounded-md border p-3 transition-colors",
              choice === option.value ? (option.value === "verify" ? "border-structure bg-structure/5" : "border-danger bg-danger-surface") : "border-border hover:border-border-strong",
            )}
          >
            <input type="radio" name="rental-check" value={option.value} checked={choice === option.value} onChange={() => setChoice(option.value)} className="mt-1 size-4 accent-current" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{option.label}</span>
              <span className="text-xs text-foreground-muted">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
      {choice === "reject" ? (
        <Field
          label="Motif montré à l'agence"
          required
          error={reasonError}
          hint="Montré tel quel : précis, sans donnée personnelle. Exemple : « Le numéro de la décision ne correspond pas à celui déclaré. »"
        >
          <textarea
            name="reason"
            rows={3}
            maxLength={RENTAL_CHECK_REASON_MAX}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className={cn(inputClassName, "h-auto min-h-20 py-2")}
          />
        </Field>
      ) : null}
      {error ? <ErrorBanner title={error} /> : null}
      <Button type="submit" variant={choice === "verify" ? "structure" : "danger"} loading={loading}>
        {choice === "verify" ? "Marquer l'agrément contrôlé" : "Refuser le document"}
      </Button>
    </form>
  );
}
