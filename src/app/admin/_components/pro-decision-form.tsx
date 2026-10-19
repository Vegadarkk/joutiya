"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { inputClassName } from "@/components/ui/input";
import { PRO_REGISTRY_SOURCES, PRO_REJECT_REASON_MAX, PRO_REJECT_REASON_MIN, type ProDecisionInput, type ProDecisionResponse } from "@/lib/contracts/pro";
import { cn } from "@/lib/utils";
import { adminFetch, errorMessage } from "./api-client";

// Decision on a Pro application (phase 7 design §4): verify (registry consulted, phone verified)
// or reject with a motivated reason sent to the applicant as written. `submittedAt` pins the
// application the page showed: a resubmission meanwhile answers 409.

const MESSAGES: Record<string, string> = {
  conflict: "La demande a changé depuis l'ouverture de la page (nouvel envoi ou décision d'un autre modérateur). Rechargez la page.",
  phone_unverified: "Le numéro du demandeur n'est pas vérifié : appelez-le et notez l'appel avant de valider.",
  account_suspended: "Le compte du demandeur n'est pas actif : la demande ne peut pas être validée.",
  not_found: "Cette demande n'existe plus.",
  invalid_body: `Le motif doit compter de ${PRO_REJECT_REASON_MIN} à ${PRO_REJECT_REASON_MAX} caractères.`,
  forbidden: "Réservé aux modérateurs et aux admins.",
  rate_limited: "Trop de décisions en peu de temps. Réessayez dans quelques minutes.",
};

const REGISTRY_LABEL: Record<(typeof PRO_REGISTRY_SOURCES)[number], string> = { ompic: "OMPIC (registre du commerce)", directinfo: "DirectInfo" };

type Choice = "verify" | "reject";

async function decide(proId: string, body: ProDecisionInput): Promise<ProDecisionResponse | null> {
  return adminFetch<ProDecisionResponse>(`/api/admin/pros/${encodeURIComponent(proId)}`, { method: "POST", csrf: true, body });
}

interface ProDecisionFormProps {
  proId: string;
  submittedAt: string;
  phoneVerified: boolean;
  ownerActive: boolean;
}

export function ProDecisionForm({ proId, submittedAt, phoneVerified, ownerActive }: ProDecisionFormProps) {
  const router = useRouter();
  const groupId = useId();
  const [choice, setChoice] = useState<Choice>("verify");
  const [registry, setRegistry] = useState<(typeof PRO_REGISTRY_SOURCES)[number] | "">("");
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState<{ registry?: string; reason?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const verifyBlocked = !phoneVerified || !ownerActive;

  function validate(): ProDecisionInput | null {
    if (choice === "verify") {
      if (!registry) {
        setFieldError({ registry: "Indiquez le registre consulté." });
        return null;
      }
      return { action: "verify", registrySource: registry, submittedAt };
    }
    const text = reason.trim();
    if (text.length < PRO_REJECT_REASON_MIN) {
      setFieldError({ reason: `Expliquez le motif en au moins ${PRO_REJECT_REASON_MIN} caractères.` });
      return null;
    }
    return { action: "reject", reason: text, submittedAt };
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldError({});
    const body = validate();
    if (!body) return;
    setLoading(true);
    try {
      const result = await decide(proId, body);
      if (body.action === "reject") toast.success("Demande refusée", { description: "Le demandeur reçoit le motif par e-mail." });
      else if (result?.effectsPending) toast.warning("Boutique validée, effets en attente", { description: "Le passage en Pro sera relancé cette nuit, ou depuis cette page." });
      else toast.success("Boutique validée", { description: "Le compte passe Pro ; le demandeur est prévenu par e-mail." });
      router.push("/pros");
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
      setLoading(false);
    }
  }

  const choices: { value: Choice; label: string; description: string }[] = [
    { value: "verify", label: "Valider", description: "Le compte passe Pro avec l'offre en vigueur ; ses annonces portent le badge Pro." },
    { value: "reject", label: "Refuser", description: "Le demandeur reçoit le motif et peut corriger puis renvoyer sa demande." },
  ];

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <h2 id={groupId} className="text-lg font-semibold">
        Décision
      </h2>
      <div role="radiogroup" aria-labelledby={groupId} className="grid gap-2">
        {choices.map((option) => (
          <label
            key={option.value}
            className={cn(
              "flex cursor-pointer gap-3 rounded-md border p-3 transition-colors",
              choice === option.value ? (option.value === "verify" ? "border-structure bg-structure/5" : "border-danger bg-danger-surface") : "border-border hover:border-border-strong",
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

      {choice === "verify" ? (
        <>
          <Field label="Registre consulté" required error={fieldError.registry}>
            <select name="registry" value={registry} onChange={(event) => setRegistry(event.target.value as typeof registry)} className={inputClassName}>
              <option value="">Choisir le registre</option>
              {PRO_REGISTRY_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {REGISTRY_LABEL[source]}
                </option>
              ))}
            </select>
          </Field>
          {verifyBlocked ? (
            <p className="text-sm text-warning">
              {ownerActive ? "Validation impossible tant que le numéro du demandeur n'est pas vérifié : notez d'abord l'appel." : "Validation impossible : le compte du demandeur n'est pas actif."}
            </p>
          ) : null}
        </>
      ) : (
        <Field label="Motif envoyé au demandeur" required error={fieldError.reason} hint="Envoyé tel quel : précis, sans donnée personnelle. Exemple : « L'ICE ne correspond pas au registre du commerce. »">
          <textarea name="reason" rows={4} maxLength={PRO_REJECT_REASON_MAX} value={reason} onChange={(event) => setReason(event.target.value)} className={cn(inputClassName, "h-auto min-h-24 py-2")} />
        </Field>
      )}

      {error ? <ErrorBanner title={error} /> : null}
      <Button type="submit" variant={choice === "verify" ? "structure" : "danger"} loading={loading} disabled={choice === "verify" && verifyBlocked}>
        {choice === "verify" ? "Valider la boutique" : "Refuser la demande"}
      </Button>
    </form>
  );
}

/** A verified shop whose claims grant or listings retag failed: the same verify reruns them. */
export function ProEffectsRerun({ proId, submittedAt, registrySource }: { proId: string; submittedAt: string; registrySource: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function rerun() {
    setError(null);
    setLoading(true);
    try {
      const result = await decide(proId, { action: "verify", registrySource: registrySource as (typeof PRO_REGISTRY_SOURCES)[number], submittedAt });
      if (result?.effectsPending) toast.warning("Effets toujours en attente", { description: "Réessayez plus tard ; la relance de nuit continue." });
      else toast.success("Passage en Pro terminé");
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, { ...MESSAGES, conflict: "Les effets sont déjà appliqués. Rechargez la page." }));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-danger/40 bg-surface p-5">
      <h2 className="text-lg font-semibold">Passage en Pro inachevé</h2>
      <p className="text-sm text-foreground-muted">La boutique est validée mais les droits Pro du compte ou le badge de ses annonces n’ont pas pu être appliqués. Une relance a lieu chaque nuit.</p>
      {error ? <ErrorBanner title={error} /> : null}
      <Button type="button" variant="structure" loading={loading} onClick={() => void rerun()}>
        Relancer maintenant
      </Button>
    </section>
  );
}
