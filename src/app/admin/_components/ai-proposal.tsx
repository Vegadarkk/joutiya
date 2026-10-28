import type { ReactNode } from "react";
import { Bot } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { AiProposal } from "@/lib/reports/admin";
import { formatDateTime, reasonLabel } from "../_lib/moderation-format";

// The agent's proposal as the staff see it (design D19, D24): advisory only, never applied by
// this screen; the verdict is read before the content-centric action (audit D1b-10).

const TASK_LABEL: Record<string, string> = { listing_screen: "Contrôle de l'annonce", report_triage: "Tri du signalement", appeal_review: "Examen du recours" };
const VERDICT_LABEL: Record<string, string> = {
  founded: "Signalement fondé",
  unfounded: "Signalement non fondé",
  needs_human: "Examen humain nécessaire",
  unclear: "Incertain",
};
const APPEAL_VERDICT_LABEL: Record<string, string> = { founded: "Recours fondé", unfounded: "Recours non fondé", needs_human: "Examen humain nécessaire", unclear: "Incertain" };
const ACTION_LABEL: Record<string, Record<string, string>> = {
  listing_screen: { approve: "Publier", hold: "Retenir pour un humain", reject: "Refuser", escalate: "Transmettre à un humain" },
  report_triage: { approve: "Signalement non fondé", hold: "Retenir pour un humain", reject: "Signalement fondé", escalate: "Transmettre à un humain" },
  appeal_review: { approve: "Annuler la décision", hold: "Retenir pour un humain", reject: "Maintenir la décision", escalate: "Transmettre à un humain" },
};
const APPLIED_LABEL: Record<AiProposal["applied"], string> = {
  auto: "Appliquée automatiquement",
  pending: "En attente",
  confirmed: "Suivie",
  edited: "Suivie avec des modifications",
  rejected: "Écartée",
  handed_over: "Transmise, décidée par un humain",
};

export function aiOpinion(ai: Pick<AiProposal, "task" | "verdict" | "action">): string {
  if (ai.verdict) return (ai.task === "appeal_review" ? APPEAL_VERDICT_LABEL : VERDICT_LABEL)[ai.verdict] ?? ai.verdict;
  return ACTION_LABEL[ai.task]?.[ai.action] ?? ai.action;
}

interface AiProposalPanelProps {
  ai: AiProposal;
  /** The registry template the proposal maps to, if any (its label). */
  templateLabel?: string | null;
  /** "Use this template" and the like. */
  action?: ReactNode;
}

export function AiProposalPanel({ ai, templateLabel, action }: AiProposalPanelProps) {
  const percent = Math.round(Math.min(1, Math.max(0, ai.confidence)) * 100);
  return (
    <section aria-labelledby="ai-proposal-title" className="flex flex-col gap-3 rounded-lg border border-dashed border-border-strong bg-surface p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 id="ai-proposal-title" className="flex items-center gap-2 text-lg font-semibold">
          <Bot aria-hidden="true" className="size-5 text-foreground-muted" />
          Proposition de l&apos;agent
        </h2>
        <Badge variant={ai.applied === "pending" ? "warning" : "neutral"}>{APPLIED_LABEL[ai.applied]}</Badge>
      </div>
      <p className="text-sm text-foreground-muted">Avis consultatif : rien n&apos;est appliqué sans votre décision.</p>
      <div className="flex flex-col gap-1.5">
        <p className="font-medium">{aiOpinion(ai)}</p>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-foreground-muted">Confiance</span>
          <span aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted">
            <span className="block h-full rounded-full bg-foreground-muted" style={{ width: `${percent}%` }} />
          </span>
          <span className="font-medium tabular-nums">{percent} %</span>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-foreground-muted">Tâche</dt>
        <dd>{TASK_LABEL[ai.task] ?? ai.task}</dd>
        {ai.policy && ai.policy !== "none" ? (
          <>
            <dt className="text-foreground-muted">Motif retenu</dt>
            <dd>{reasonLabel(ai.policy)}</dd>
          </>
        ) : null}
        <dt className="text-foreground-muted">Gravité</dt>
        <dd>{ai.severity}</dd>
        {templateLabel ? (
          <>
            <dt className="text-foreground-muted">Modèle suggéré</dt>
            <dd>{templateLabel}</dd>
          </>
        ) : null}
        <dt className="text-foreground-muted">Modèle d&apos;IA</dt>
        <dd className="break-words">
          {ai.model} ({ai.provider}), {formatDateTime(ai.createdAt)}
        </dd>
      </dl>
      {ai.rationale ? (
        <p dir="auto" className="rounded-md bg-surface-muted p-3 text-sm text-pretty whitespace-pre-line">
          {ai.rationale}
        </p>
      ) : null}
      {ai.userMessage ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-link underline-offset-4 hover:underline">Brouillon de motivation proposé</summary>
          <p dir="auto" className="mt-2 text-pretty whitespace-pre-line text-foreground-muted">
            {ai.userMessage}
          </p>
        </details>
      ) : null}
      {action}
    </section>
  );
}
