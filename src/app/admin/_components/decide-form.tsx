"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { inputClassName } from "@/components/ui/input";
import { DETAILS_MAX, decisionTemplate, fillTemplateText, type DecisionTargetType, type DecisionTemplate } from "@/config/decision-templates";
import type { DecideResponse } from "@/lib/decisions/contracts";
import type { AiProposal } from "@/lib/reports/admin";
import { cn } from "@/lib/utils";
import { plural } from "../_lib/moderation-format";
import { ADMIN_API, adminFetch, errorMessage } from "./api-client";
import {
  AI_REVIEW_LABEL,
  aiReview,
  aiTemplate,
  buildDecideRequest,
  confirmLabel,
  decideProblems,
  defaultSanction,
  noticeLine,
  offersSanction,
  proposedStep,
  SANCTION_CHOICES,
  SANCTION_LABEL,
  sanctionAllowed,
  STRIKE_LABEL,
  templateAllowed,
  templateGroups,
  type DecideContext,
  type DecideProblems,
  type SanctionChoice,
} from "./decide-state";

const MESSAGES: Record<string, string> = {
  conflict: "Rien à décider dans cet état : une décision vient peut-être d'être prise, ou le contenu a changé. Rechargez la page.",
  not_found: "Ce contenu ou ce compte n'existe plus.",
  sanction_not_allowed: "Sanction refusée : un modérateur ne ferme un compte que pour confirmer un signalement P0 ouvert.",
  invalid_body: "Décision refusée : vérifiez le modèle, la précision et la sanction.",
  forbidden: "Réservé aux modérateurs et aux admins.",
  rate_limited: "Trop de décisions en peu de temps. Réessayez dans quelques minutes.",
};

const SUCCESS: Partial<Record<DecisionTemplate["action"], string>> = {
  remove: "Contenu retiré",
  restrict_visibility: "Visibilité restreinte",
  restore: "Contenu rétabli",
  no_action: "Signalements classés sans suite",
  warn: "Compte averti",
  suspend_account: "Compte suspendu",
  ban: "Compte fermé",
};

interface DecideFormProps {
  /** `{type}:{id}` of the target. */
  targetKey: string;
  targetType: DecisionTargetType;
  role: DecideContext["role"];
  priorities: DecideContext["priorities"];
  strikes: number | null;
  openCount: number;
  ai: AiProposal | null;
}

/**
 * One decision on one target (D13): a template of the catalogue, the moderator's own words, an
 * account sanction proposed by the ladder (D14), then a recap to confirm. The agent's proposal
 * (shown by the page, advisory) may preselect its template, and is marked by what the moderator decides.
 */
export function DecideForm({ targetKey, targetType, role, priorities, strikes, openCount, ai }: DecideFormProps) {
  const router = useRouter();
  const formId = useId();
  const context: DecideContext = { targetType, role, priorities, strikes };
  const groups = templateGroups(targetType);
  const suggested = ai ? aiTemplate(ai, targetType) : null;
  const ladder = proposedStep(strikes);
  const [templateId, setTemplateId] = useState("");
  const [details, setDetails] = useState("");
  const [sanction, setSanction] = useState<SanctionChoice>("none");
  const [manifest, setManifest] = useState(false);
  const [problems, setProblems] = useState<DecideProblems>({});
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const template = templateId ? (decisionTemplate(templateId) ?? null) : null;
  const draft = { template, details, sanction, manifestlyUnfounded: manifest };

  function choose(id: string) {
    const next = id ? (decisionTemplate(id) ?? null) : null;
    setTemplateId(id);
    // The ladder may propose a ban a moderator cannot apply: the strongest step he can is preselected.
    const proposed = next ? defaultSanction(next, context) : "none";
    setSanction(sanctionAllowed(proposed, context) ? proposed : "suspend_30");
    setManifest(false);
    setProblems({});
    setError(null);
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const found = decideProblems(draft, context);
    setProblems(found);
    if (Object.keys(found).length === 0) setConfirming(true);
  }

  async function confirm() {
    if (!template) return;
    setLoading(true);
    setError(null);
    try {
      const body = buildDecideRequest(targetKey, { ...draft, template }, context, ai);
      const result = await adminFetch<DecideResponse>(ADMIN_API.decisions, { method: "POST", csrf: true, body });
      const closed = result?.reportIds.length ?? 0;
      toast.success(SUCCESS[template.action] ?? "Décision enregistrée", { description: closed > 0 ? `${plural(closed, "signalement clos", "signalements clos")}.` : undefined });
      router.push("/signalements");
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
      setConfirming(false);
      setLoading(false);
    }
  }

  const option = (item: DecisionTemplate) => {
    const allowed = templateAllowed(item, context);
    return (
      <option key={item.id} value={item.id} disabled={!allowed}>
        {`${item.label}${allowed ? "" : " (admin)"}`}
      </option>
    );
  };
  const showSanction = template !== null && offersSanction(template, targetType);
  const sanctionStep = template ? defaultSanction(template, context) : "none";
  const review_ = template ? aiReview(ai, template, targetType) : null;
  const restrictive = template !== null && template.outcome === "founded";

  return (
    <form onSubmit={review} noValidate aria-labelledby={`${formId}-title`} className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <h2 id={`${formId}-title`} className="text-lg font-semibold">
        Décision
      </h2>
      {openCount === 0 ? <p className="text-sm text-foreground-muted">Aucun signalement ouvert : la décision sera prise d&apos;initiative.</p> : null}
      <fieldset disabled={confirming || loading} className="flex flex-col gap-4">
        {suggested && templateAllowed(suggested, context) ? (
          <p className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-border-strong px-3 py-2 text-sm">
            <span>
              <span className="text-foreground-muted">Suggestion de l&apos;agent : </span>
              {suggested.label}
            </span>
            {suggested.id !== templateId ? (
              <Button type="button" variant="outline" size="sm" onClick={() => choose(suggested.id)}>
                Partir de la suggestion
              </Button>
            ) : null}
          </p>
        ) : null}
        <Field label="Modèle de décision" required error={problems.template}>
          <select name="template" value={templateId} onChange={(event) => choose(event.target.value)} className={inputClassName}>
            <option value="">Choisir un modèle</option>
            <optgroup label="Mesures (signalements fondés)">{groups.measures.map(option)}</optgroup>
            <optgroup label="Sans mesure (signalements non fondés)">{groups.dismissals.map(option)}</optgroup>
          </select>
        </Field>

        {targetType === "user" && ladder ? (
          <p className="text-sm text-foreground-muted">
            Niveau actuel : {STRIKE_LABEL[Math.min(3, Math.max(0, strikes ?? 0))]}. Étape proposée par l&apos;échelle : <span className="font-medium text-foreground">{SANCTION_LABEL[ladder]}</span>.
          </p>
        ) : null}

        {template ? (
          <div className="flex flex-col gap-1.5 rounded-md bg-surface-muted p-3 text-sm">
            <p>
              <span className="text-foreground-muted">Fondement : </span>
              {template.ground.type === "illegal" ? "contenu illicite" : "conditions d'utilisation"}, {template.ground.ref}
            </p>
            <p className="text-pretty">
              <span className="text-foreground-muted">Faits : </span>
              {fillTemplateText(template.facts.fr, { days: template.durationDays })}.
            </p>
            {template.p0 ? <p className="font-medium text-danger">Confirme un contenu P0 : le compte est fermé immédiatement.</p> : null}
          </div>
        ) : null}

        {showSanction ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium">Sanction du compte</legend>
            <div className="grid gap-1.5">
              {SANCTION_CHOICES.map((choice) => {
                const allowed = sanctionAllowed(choice, context);
                return (
                  <label
                    key={choice}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors",
                      allowed ? "cursor-pointer" : "cursor-not-allowed opacity-60",
                      sanction === choice ? "border-structure bg-structure/5" : "border-border hover:border-border-strong",
                    )}
                  >
                    <input type="radio" name="sanction" value={choice} checked={sanction === choice} disabled={!allowed} onChange={() => setSanction(choice)} className="size-4 accent-current" />
                    <span className="flex-1">{SANCTION_LABEL[choice]}</span>
                    {choice === sanctionStep && choice !== "none" ? <span className="text-xs font-medium text-structure dark:text-bab-300">Proposée</span> : null}
                    {!allowed ? <span className="text-xs text-foreground-muted">Admin</span> : null}
                  </label>
                );
              })}
            </div>
            {problems.sanction ? <p className="text-sm text-danger">{problems.sanction}</p> : null}
            {strikes !== null ? <p className="text-sm text-foreground-muted">Niveau actuel du compte : {STRIKE_LABEL[Math.min(3, Math.max(0, strikes))]}.</p> : null}
          </fieldset>
        ) : null}

        <Field
          label="Précision du modérateur"
          required={template?.detailsRequired === true}
          error={problems.details}
          hint="Citée telle quelle dans l'exposé des motifs. Aucune donnée personnelle."
        >
          <textarea name="details" rows={3} maxLength={DETAILS_MAX} value={details} onChange={(event) => setDetails(event.target.value)} className={cn(inputClassName, "h-auto min-h-20 py-2")} />
        </Field>

        {template?.outcome === "unfounded" && openCount > 0 ? (
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input type="checkbox" checked={manifest} onChange={(event) => setManifest(event.target.checked)} className="mt-0.5 size-4 accent-current" />
            <span>
              Signalements manifestement infondés
              <span className="block text-foreground-muted">Comptent pour l&apos;avertissement puis la suspension des signalants abusifs (art. 23).</span>
            </span>
          </label>
        ) : null}
      </fieldset>

      {error ? <ErrorBanner title={error} /> : null}

      {confirming && template ? (
        <div role="group" aria-label="Récapitulatif avant confirmation" className="flex flex-col gap-3 rounded-md border border-border-strong p-4">
          <h3 className="font-medium">Avant de confirmer</h3>
          <ul className="flex list-disc flex-col gap-1 ps-5 text-sm">
            <li>{template.label}.</li>
            {showSanction && sanction !== "none" ? <li>Sanction du compte : {SANCTION_LABEL[sanction].toLowerCase()}.</li> : null}
            <li>{openCount > 0 ? `${plural(openCount, "signalement ouvert sera clos", "signalements ouverts seront clos")}${manifest ? ", marqués manifestement infondés" : ""}.` : "Décision d'initiative, sans signalement ouvert."}</li>
            <li>{noticeLine(template, targetType)}</li>
            {review_ ? <li>Proposition de l&apos;agent : {AI_REVIEW_LABEL[review_.outcome]}.</li> : null}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant={restrictive ? "danger" : "structure"} loading={loading} onClick={confirm}>
              {confirmLabel(template, targetType)}
            </Button>
            <Button type="button" variant="outline" disabled={loading} onClick={() => setConfirming(false)}>
              Modifier
            </Button>
          </div>
        </div>
      ) : (
        <Button type="submit" variant="structure">
          Vérifier la décision
        </Button>
      )}
    </form>
  );
}
