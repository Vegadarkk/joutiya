import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DECISION_TARGET_TYPES, RESTRICTIVE_ACTIONS, type DecisionTargetType } from "@/config/decision-templates";
import { Badge } from "@/components/ui/badge";
import { requirePageStaff } from "@/lib/auth/current-user";
import { canReview } from "@/lib/decisions/appeals";
import { APPEAL_SLA_DAYS, docIdSchema } from "@/lib/decisions/contracts";
import { appealProposal } from "@/lib/decisions/hooks";
import { getDecision } from "@/lib/decisions/repository";
import { decisionView } from "@/lib/decisions/views";
import { getStaff } from "@/lib/db/repositories/staff";
import { aiProposal } from "@/lib/reports/admin";
import {
  ACTION_LABEL,
  APPEAL_STATUS_LABEL,
  decisionTargetHref,
  formatDateTime,
  ORIGIN_LABEL,
  plural,
  TARGET_LABEL,
  templateLabel,
} from "../../../_lib/moderation-format";
import { AiProposalPanel } from "../../../_components/ai-proposal";
import { AppealReviewForm } from "../../../_components/appeal-review-form";
import { Facts, linkClassName, Panel } from "../../../_components/panel";
import { ResendNoticeButton } from "../../../_components/resend-notice-button";
import { LiveSlaTimer } from "../../../_components/sla-timer";

// One decision (design D13, D16, D24): its statement of reasons, its notification (re-sent from
// here), and its appeal: the agent's appeal_review proposal (advisory) and the review form. A
// moderator never reviews his own decision; an admin may, with a visible journaled notice.

export const metadata: Metadata = { title: "Décision" };

const APPEAL_WINDOW_MS = APPEAL_SLA_DAYS * 24 * 60 * 60 * 1000;

async function staffName(uid: string | null, me: string, automated: boolean): Promise<string> {
  if (!uid) return "Inconnu";
  if (uid === me) return "Vous";
  const record = await getStaff(uid).catch(() => null);
  if (record) return record.displayName || record.email;
  return automated ? "Agent automatique" : uid;
}

export default async function DecisionPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await requirePageStaff(["moderator", "admin"]);
  const id = docIdSchema.safeParse((await params).id);
  if (!id.success) notFound();
  const record = await getDecision(id.data);
  if (!record) notFound();
  const decision = decisionView(record);
  const { appeal } = decision;
  const restrictive = (RESTRICTIVE_ACTIONS as readonly string[]).includes(decision.action);
  const openAppeal = appeal?.status === "open";
  const proposal = appeal ? await appealProposal(decision.id) : null;
  const [ai, decidedBy, reviewer] = await Promise.all([
    proposal ? aiProposal(proposal.id) : null,
    staffName(decision.decidedBy, staff.uid, decision.automated.decision),
    appeal?.reviewer ? staffName(appeal.reviewer, staff.uid, false) : null,
  ]);
  const reviewable = canReview(record, { uid: staff.uid, role: staff.role });
  const targetType = (DECISION_TARGET_TYPES as readonly string[]).includes(decision.target.type) ? (decision.target.type as DecisionTargetType) : null;
  const resendable = restrictive && !decision.supersededBy && !(decision.origin === "authority_order" && !decision.notifiedAt);

  return (
    <>
      <div className="flex flex-col gap-2">
        <Link href={openAppeal ? "/recours" : "/signalements"} className={`self-start text-sm ${linkClassName}`}>
          {openAppeal ? "Retour aux recours" : "Retour aux signalements"}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-balance">{templateLabel(decision.templateId)}</h1>
          <Badge variant={restrictive ? "warning" : "neutral"}>{ACTION_LABEL[decision.action]}</Badge>
          {appeal ? <Badge variant={appeal.status === "open" ? "danger" : "neutral"}>{APPEAL_STATUS_LABEL[appeal.status]}</Badge> : null}
        </div>
        <p className="text-sm text-foreground-muted">
          Décision {decision.id} du {formatDateTime(decision.createdAt)}.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div className="flex flex-col gap-6">
          <Panel title="Exposé des motifs">
            <Facts
              rows={[
                [
                  "Cible",
                  <Link key="target" href={decisionTargetHref(decision.target)} className={linkClassName}>
                    {TARGET_LABEL[decision.target.type] ?? decision.target.type} {decision.target.id}
                  </Link>,
                ],
                [
                  "Compte concerné",
                  <Link key="affected" href={`/comptes/${encodeURIComponent(decision.affectedUid)}`} className={linkClassName}>
                    {decision.affectedUid}
                  </Link>,
                ],
                ["Origine", `${ORIGIN_LABEL[decision.origin]}${decision.reportIds.length > 0 ? `, ${plural(decision.reportIds.length, "signalement", "signalements")}` : ""}`],
                ["Automatisation", decision.automated.decision ? "Décision automatique" : decision.automated.detection ? "Détection automatique, décision humaine" : "Aucune"],
                ["Décidée par", decidedBy],
                ...(decision.durationDays ? ([["Durée", `${decision.durationDays} jours`]] as [string, string][]) : []),
                ["Fondement", `${decision.ground.type === "illegal" ? "Contenu illicite" : "Conditions d'utilisation"}, ${decision.ground.ref}`],
                ["Recours possible jusqu'au", formatDateTime(decision.appealDeadline)],
              ]}
            />
            <div className="flex flex-col gap-2 border-t border-border pt-3 text-sm">
              <p className="max-w-prose text-pretty whitespace-pre-line">
                <span className="text-foreground-muted">Faits : </span>
                {decision.facts}
              </p>
              <p className="max-w-prose text-pretty">
                <span className="text-foreground-muted">Motif : </span>
                {decision.ground.explanation}
              </p>
            </div>
            {decision.supersedes || decision.supersededBy || appeal?.outcomeDecisionId ? (
              <p className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3 text-sm">
                {decision.supersedes ? (
                  <Link href={`/decisions/${decision.supersedes}`} className={linkClassName}>
                    Décision annulée par celle-ci
                  </Link>
                ) : null}
                {decision.supersededBy ? (
                  <Link href={`/decisions/${decision.supersededBy}`} className={linkClassName}>
                    Décision qui l&apos;annule
                  </Link>
                ) : null}
                {appeal?.outcomeDecisionId && appeal.outcomeDecisionId !== decision.supersededBy ? (
                  <Link href={`/decisions/${appeal.outcomeDecisionId}`} className={linkClassName}>
                    Mesure prise sur recours
                  </Link>
                ) : null}
              </p>
            ) : null}
          </Panel>

          <Panel title="Notification">
            <p className="text-sm">
              {restrictive
                ? decision.notifiedAt
                  ? `Exposé des motifs mis en envoi le ${formatDateTime(decision.notifiedAt)}.`
                  : decision.origin === "authority_order"
                    ? "Non notifiée : l'injonction interdit d'informer la personne concernée."
                    : "Pas encore notifiée (quota d'e-mails dégradé au moment de la décision)."
                : "Cette décision ne restreint personne : pas d'exposé des motifs. Les signalants reçoivent l'issue."}
            </p>
            {resendable ? (
              <div>
                <ResendNoticeButton decisionId={decision.id} />
              </div>
            ) : null}
          </Panel>

          {appeal ? (
            <Panel title="Recours" meta={appeal.status === "open" && appeal.slaDueAt ? <LiveSlaTimer dueAt={appeal.slaDueAt} renderedAt={new Date().toISOString()} windowMs={APPEAL_WINDOW_MS} /> : null}>
              <Facts
                rows={[
                  ["Auteur", appeal.by === "reporter" ? "Un signalant" : "La personne concernée"],
                  ["Ouvert le", formatDateTime(appeal.openedAt)],
                  ...(appeal.closedAt ? ([["Clos le", formatDateTime(appeal.closedAt)]] as [string, string][]) : []),
                  ...(reviewer ? ([["Réexaminé par", `${reviewer}${appeal.selfReview ? " (auteur de la décision, réexamen journalisé)" : ""}`]] as [string, string][]) : []),
                ]}
              />
              {appeal.text ? (
                <p dir="auto" className="max-w-prose rounded-md bg-surface-muted p-3 text-sm text-pretty whitespace-pre-line">
                  {appeal.text}
                </p>
              ) : null}
              {appeal.note ? (
                <div className="text-sm">
                  <h3 className="mb-1 font-medium text-foreground-muted">Réponse envoyée</h3>
                  <p className="max-w-prose text-pretty whitespace-pre-line">{appeal.note}</p>
                </div>
              ) : null}
            </Panel>
          ) : null}
        </div>

        <aside className="flex flex-col gap-6" aria-label="Réexamen du recours">
          {ai ? <AiProposalPanel ai={ai} /> : null}
          {openAppeal ? (
            reviewable ? (
              <AppealReviewForm
                decisionId={decision.id}
                restrictive={restrictive}
                targetType={targetType}
                role={staff.role}
                selfReview={record.decidedBy === staff.uid}
              />
            ) : (
              <Panel title="Réexamen">
                <p className="text-sm text-foreground-muted">Vous avez pris cette décision : un autre modérateur, ou un admin, réexamine ce recours.</p>
              </Panel>
            )
          ) : null}
        </aside>
      </div>
    </>
  );
}
