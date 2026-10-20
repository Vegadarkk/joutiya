"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { inputClassName } from "@/components/ui/input";
import type { ProPhoneCheckInput, ProPhoneCheckResponse } from "@/lib/contracts/pro";
import type { PhoneCheckOutcome } from "@/lib/pro/profile-schema";
import { cn } from "@/lib/utils";
import { adminFetch, errorMessage } from "./api-client";
import { PHONE_OUTCOME_LABEL } from "./pro-labels";

// The moderator's call to the applicant (phase 7, while the WhatsApp check is unavailable): the
// outcome is recorded with the moderator's name; "confirmed" verifies the number on the account.

const MESSAGES: Record<string, string> = {
  conflict: "La demande a changé (décidée, ou numéro déjà vérifié). Rechargez la page.",
  phone_required: "Aucun numéro à vérifier : saisissez celui donné par le demandeur.",
  phone_invalid: "Ce numéro n'est pas un mobile marocain valide.",
  phone_not_mobile: "Seuls les mobiles (06, 07) peuvent être vérifiés.",
  account_suspended: "Le compte du demandeur n'est pas actif.",
  not_found: "Cette demande n'existe plus.",
  forbidden: "Réservé aux modérateurs et aux admins.",
  rate_limited: "Trop d'actions en peu de temps. Réessayez dans quelques minutes.",
};

const OUTCOMES: { value: PhoneCheckOutcome; description: string }[] = [
  { value: "verified", description: "Le demandeur a répondu et confirmé sa demande : le numéro est vérifié sur son compte." },
  { value: "unreachable", description: "Pas de réponse : l'appel est noté, la demande attend un nouvel appel." },
  { value: "mismatch", description: "La personne jointe n'a pas fait la demande : l'appel est noté, refusez ensuite." },
];

export function ProPhoneCheckForm({ proId, declared }: { proId: string; declared: string | null }) {
  const router = useRouter();
  const groupId = useId();
  const [outcome, setOutcome] = useState<PhoneCheckOutcome>("verified");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!declared && !phone.trim()) {
      setError(MESSAGES["phone_required"]!);
      return;
    }
    setError(null);
    setLoading(true);
    const body: ProPhoneCheckInput = { outcome, ...(phone.trim() ? { phone: phone.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) };
    try {
      const result = await adminFetch<ProPhoneCheckResponse>(`/api/admin/pros/${encodeURIComponent(proId)}/phone`, { method: "POST", csrf: true, body });
      toast.success(result?.phoneVerified ? "Numéro vérifié" : "Appel noté", result?.transferred ? { description: "Le numéro a été retiré du compte qui le détenait ; son titulaire est prévenu." } : undefined);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3 border-t border-border pt-3">
      <p id={groupId} className="text-sm font-medium">
        Résultat de l’appel
      </p>
      <div role="radiogroup" aria-labelledby={groupId} className="grid gap-2">
        {OUTCOMES.map((option) => (
          <label
            key={option.value}
            className={cn("flex cursor-pointer gap-3 rounded-md border p-3 transition-colors", outcome === option.value ? "border-structure bg-structure/5" : "border-border hover:border-border-strong")}
          >
            <input type="radio" name="outcome" value={option.value} checked={outcome === option.value} onChange={() => setOutcome(option.value)} className="mt-1 size-4 accent-current" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{PHONE_OUTCOME_LABEL[option.value]}</span>
              <span className="text-xs text-foreground-muted">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
      <Field label={declared ? "Autre numéro (s'il a été corrigé pendant l'appel)" : "Numéro appelé"} required={!declared}>
        <input type="tel" inputMode="tel" autoComplete="off" dir="ltr" value={phone} onChange={(event) => setPhone(event.target.value)} className={inputClassName} placeholder="06 12 34 56 78" />
      </Field>
      <Field label="Note interne" hint="Pour le modérateur suivant ; rien d'autre sur le demandeur que l'appel lui-même.">
        <input type="text" maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} className={inputClassName} />
      </Field>
      {error ? <ErrorBanner title={error} /> : null}
      <Button type="submit" variant="structure" loading={loading}>
        Enregistrer l’appel
      </Button>
    </form>
  );
}
