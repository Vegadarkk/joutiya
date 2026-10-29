import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import type { DecisionTargetType } from "@/config/decision-templates";
import { Badge } from "@/components/ui/badge";
import { requirePageStaff } from "@/lib/auth/current-user";
import { serverEnv } from "@/lib/env";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { reportTargetView, type ReportDetail, type ReportTargetView, type TargetSnapshot } from "@/lib/reports/admin";
import { parseTargetKey } from "@/lib/reports/target-key";
import { staffPhotoPath } from "../../../_lib/staff-photos";
import {
  ACCOUNT_STATUS_LABEL,
  APPEAL_STATUS_LABEL,
  formatDateTime,
  ORIGIN_LABEL,
  plural,
  PRIORITY_TONE,
  prioritySla,
  reasonLabel,
  REPORTER_LABEL,
  SIGNAL_LABEL,
  templateLabel,
} from "../../../_lib/moderation-format";
import { DecideForm } from "../../../_components/decide-form";
import { formatPrice } from "../../../_components/moderation-labels";
import { Facts, linkClassName, Panel } from "../../../_components/panel";
import { LiveSlaTimer } from "../../../_components/sla-timer";
import { aiTemplate, STRIKE_LABEL } from "../../../_components/decide-state";
import { AiProposalPanel } from "../../../_components/ai-proposal";

// Target view of the report queues (design D24): the reported content as it stands (a review: its
// note, text and the seller's reply), its open reports with the reporters' accuracy, its history
// (closed reports, decisions), the agent's latest proposal (advisory) and the decision form. A
// reported message is shown alone and its reading is journaled (message.read); the whole
// conversation needs a reason (D18).

export const metadata: Metadata = { title: "Contenu signalé" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const LISTING_STATUS: Record<string, string> = {
  draft: "Brouillon",
  pending_review: "En vérification",
  published: "En ligne",
  paused: "En pause",
  expired: "Expirée",
  sold: "Vendue",
  rejected: "Refusée",
  removed: "Retirée",
  purged: "Supprimée",
};
const DECIDABLE: readonly string[] = ["listing", "user", "message", "review"];
const REVIEW_STATUS: Record<string, string> = { published: "Publié", pending: "Retenu avant publication", hidden: "Masqué", deleted: "Supprimé par l'auteur" };

function heading(view: ReportTargetView): { title: string; status: string | null } {
  const { snapshot } = view;
  if (snapshot?.type === "listing") return { title: `Annonce « ${snapshot.title || "Sans titre"} »`, status: LISTING_STATUS[snapshot.status] ?? snapshot.status };
  if (snapshot?.type === "user") return { title: `Compte ${snapshot.displayName}`, status: ACCOUNT_STATUS_LABEL[snapshot.status] ?? snapshot.status };
  if (snapshot?.type === "message") return { title: "Message signalé", status: snapshot.hidden ? "Masqué" : "Visible" };
  if (snapshot?.type === "review") return { title: `Avis sur ${snapshot.seller.displayName}`, status: REVIEW_STATUS[snapshot.status] ?? snapshot.status };
  return { title: `Contenu ${view.target.id}`, status: "Introuvable" };
}

function Content({ snapshot, site }: { snapshot: TargetSnapshot; site: string }) {
  if (!snapshot) return <p className="text-sm text-foreground-muted">Le contenu n&apos;existe plus : seuls les signalements et les décisions restent.</p>;
  if (snapshot.type === "listing") {
    const { moderation } = snapshot;
    return (
      <>
        {snapshot.photos.length > 0 ? (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {snapshot.photos.map((photo, index) => (
              <li key={photo.id} className="aspect-[4/3] overflow-hidden rounded-md bg-surface-muted">
                <a href={staffPhotoPath(snapshot.id, photo.id, "l")} target="_blank" rel="noopener noreferrer" aria-label={`Photo ${index + 1} en grand`}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- staff route, served as is */}
                  <img src={staffPhotoPath(snapshot.id, photo.id, "s")} alt="" loading="lazy" decoding="async" className="size-full object-contain" />
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-foreground-muted">Aucune photo.</p>
        )}
        <p className="text-xl font-semibold tabular-nums">{formatPrice(snapshot.price, snapshot.isDonation)}</p>
        <p dir="auto" className="max-w-prose text-pretty whitespace-pre-line">
          {snapshot.description || "Sans description."}
        </p>
        <Facts
          className="border-t border-border pt-3"
          rows={[
            ["Référence", snapshot.id],
            ["Publication", snapshot.publishedAt ? formatDateTime(snapshot.publishedAt) : "Jamais publiée"],
            ["Contrôle", `${moderation.state}, score ${moderation.score}${moderation.flags.length > 0 ? `, ${moderation.flags.join(", ")}` : ""}`],
            ["Masquée", moderation.hiddenBy ? `Oui, depuis le ${formatDateTime(moderation.hiddenBy.at)} (${SIGNAL_LABEL[moderation.hiddenBy.signal] ?? moderation.hiddenBy.signal})` : "Non"],
            ["Publicités", snapshot.adsEligible ? "Éligible" : "Exclue"],
          ]}
        />
        {snapshot.status === "published" && snapshot.slugId && !moderation.hiddenBy ? (
          <a href={`${site}/fr/annonce/${snapshot.slugId}`} target="_blank" rel="noopener noreferrer" className={`self-start text-sm ${linkClassName}`}>
            Voir la page publique
          </a>
        ) : null}
      </>
    );
  }
  if (snapshot.type === "message") {
    return (
      <>
        <blockquote dir="auto" className="rounded-md border-s-4 border-border-strong bg-surface-muted p-3 text-pretty whitespace-pre-line">
          {snapshot.text || "Message vide."}
        </blockquote>
        {snapshot.original && snapshot.original !== snapshot.text ? (
          <div className="text-sm">
            <h3 className="mb-1 font-medium text-foreground-muted">Texte d&apos;origine conservé comme preuve</h3>
            <p dir="auto" className="rounded-md bg-warning-surface p-3 whitespace-pre-line">
              {snapshot.original}
            </p>
          </div>
        ) : null}
        <Facts
          rows={[
            ["Auteur", snapshot.sender === "seller" ? "Le vendeur" : snapshot.sender === "buyer" ? "L'acheteur" : "Inconnu"],
            ["Envoyé", snapshot.createdAt ? formatDateTime(snapshot.createdAt) : "Date inconnue"],
            ["Annonce", snapshot.listingId ?? "Inconnue"],
          ]}
        />
        <Link href={`/conversations/${snapshot.cid}`} className={`self-start text-sm ${linkClassName}`}>
          Lire toute la conversation (motif demandé, lecture journalisée)
        </Link>
      </>
    );
  }
  if (snapshot.type === "review") {
    return (
      <>
        <p className="text-lg font-semibold tabular-nums" aria-label={`Note ${snapshot.rating} sur 5`}>
          {"★".repeat(snapshot.rating)}
          <span className="text-border-strong">{"★".repeat(5 - snapshot.rating)}</span> {snapshot.rating}/5
        </p>
        <blockquote dir="auto" className="rounded-md border-s-4 border-border-strong bg-surface-muted p-3 text-pretty whitespace-pre-line">
          {snapshot.text}
        </blockquote>
        {snapshot.reply ? (
          <div className="text-sm">
            <h3 className="mb-1 font-medium text-foreground-muted">Réponse du vendeur</h3>
            <p dir="auto" className="rounded-md bg-surface-muted p-3 whitespace-pre-line">
              {snapshot.reply}
            </p>
          </div>
        ) : null}
        <Facts
          rows={[
            ["Auteur", "L'acheteur (compte concerné)"],
            [
              "Vendeur noté",
              <a key="seller" href={`${site}/fr/profil/${snapshot.seller.publicId}#avis`} target="_blank" rel="noopener noreferrer" dir="auto" className={linkClassName}>
                {snapshot.seller.displayName}
              </a>,
            ],
            ["Annonce", <span key="listing" dir="auto">{snapshot.listingTitle}</span>],
            ["Écrit le", formatDateTime(snapshot.createdAt)],
            ["Échange", "Vérifié (conversation avec réponse du vendeur)"],
          ]}
        />
        {snapshot.status === "pending" ? (
          <p className="rounded-md bg-warning-surface p-3 text-sm text-pretty">
            Avis retenu avant publication (donnée sensible possible). « Aucune mesure » le publie ; un retrait le refuse avec l&apos;exposé des motifs.
          </p>
        ) : null}
      </>
    );
  }
  return (
    <Facts
      rows={[
        ["Nom affiché", <span key="name" dir="auto">{snapshot.displayName}</span>],
        ["État du compte", ACCOUNT_STATUS_LABEL[snapshot.status] ?? snapshot.status],
        [
          "Profil public",
          <a key="profile" href={`${site}/fr/profil/${snapshot.publicId}`} target="_blank" rel="noopener noreferrer" className={linkClassName}>
            {snapshot.publicId}
          </a>,
        ],
      ]}
    />
  );
}

function Accuracy({ report }: { report: ReportDetail }) {
  const accuracy = report.reporterAccuracy;
  if (!accuracy) return null;
  const share = accuracy.share === null ? "aucun signalement décidé" : `${accuracy.founded} fondé${accuracy.founded > 1 ? "s" : ""} sur ${accuracy.decided} décidé${accuracy.decided > 1 ? "s" : ""} (${Math.round(accuracy.share * 100)} %)`;
  return (
    <span className="text-foreground-muted">
      Fiabilité : {share}, {plural(accuracy.total, "signalement", "signalements")} au total
      {accuracy.abusiveUntil ? `, signalements suspendus jusqu'au ${formatDateTime(accuracy.abusiveUntil)}` : accuracy.warned ? ", déjà averti pour abus" : ""}
    </span>
  );
}

function OpenReport({ report, renderedAt }: { report: ReportDetail; renderedAt: string }) {
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={PRIORITY_TONE[report.priority]}>{report.priority}</Badge>
        <span className="font-medium">{reasonLabel(report.reasonId)}</span>
        <span className="ms-auto">
          <LiveSlaTimer dueAt={report.slaDueAt} renderedAt={renderedAt} windowMs={prioritySla(report.priority)} />
        </span>
      </div>
      <p className="flex flex-wrap gap-x-1.5 text-sm">
        <span>
          {REPORTER_LABEL[report.reporter.kind]}
          {report.reporter.trusted ? " fiable" : ""}, le {formatDateTime(report.createdAt)}
          {report.reporterContact.email ? ", coordonnées fournies (non affichées)" : ""}.
        </span>
        <Accuracy report={report} />
      </p>
      {report.strongSignal || report.hidden ? (
        <p className="flex flex-wrap gap-1.5">
          {report.strongSignal ? <Badge variant="danger">Signal fort : {SIGNAL_LABEL[report.strongSignal]?.toLowerCase()}</Badge> : null}
          {report.hidden ? <Badge variant="warning">A masqué le contenu</Badge> : null}
        </p>
      ) : null}
      {report.explanation ? (
        <p dir="auto" className="max-w-prose rounded-md bg-surface-muted p-3 text-sm text-pretty whitespace-pre-line">
          {report.explanation}
        </p>
      ) : null}
    </li>
  );
}

function History({ view }: { view: ReportTargetView }) {
  if (view.decisions.length === 0 && view.history.length === 0) return <p className="text-sm text-foreground-muted">Aucune décision ni signalement clos sur ce contenu.</p>;
  return (
    <div className="flex flex-col gap-4">
      {view.decisions.length > 0 ? (
        <div>
          <h3 className="mb-1.5 text-sm font-medium text-foreground-muted">Décisions</h3>
          <ul className="flex flex-col divide-y divide-border text-sm">
            {view.decisions.map((decision) => (
              <li key={decision.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                <Link href={`/decisions/${decision.id}`} className={linkClassName}>
                  {templateLabel(decision.templateId)}
                </Link>
                <span className="text-foreground-muted">
                  {ORIGIN_LABEL[decision.origin]}
                  {decision.automated ? ", automatique" : ""}, {plural(decision.reportCount, "signalement", "signalements")}, {formatDateTime(decision.createdAt)}
                  {decision.appealStatus ? `. ${APPEAL_STATUS_LABEL[decision.appealStatus]}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {view.history.length > 0 ? (
        <div>
          <h3 className="mb-1.5 text-sm font-medium text-foreground-muted">Signalements clos</h3>
          <ul className="flex flex-col divide-y divide-border text-sm">
            {view.history.map((report) => (
              <li key={report.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                <span>
                  {report.priority} {reasonLabel(report.reasonId)}
                </span>
                <span className="text-foreground-muted">
                  {report.outcome === "founded" ? "Fondé" : report.outcome === "unfounded" ? (report.manifestlyUnfounded ? "Manifestement infondé" : "Non fondé") : "Clos"}
                  {report.closedAt ? `, ${formatDateTime(report.closedAt)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default async function TargetPage({ searchParams }: { searchParams: SearchParams }) {
  const staff = await requirePageStaff(["moderator", "admin"]);
  const key = (await searchParams)["cle"];
  if (typeof key !== "string" || !parseTargetKey(key)) notFound();
  const view = await reportTargetView(key, { user: staff, role: staff.role }, requestIdentity(await headers()));
  if (!view) notFound();
  const site = serverEnv().SITE_URL.replace(/\/$/, "");
  const renderedAt = new Date().toISOString();
  const { title, status } = heading(view);
  const first = view.open[0];
  const decidable = DECIDABLE.includes(view.target.type) && view.snapshot !== null;

  const type = view.target.type as DecisionTargetType;
  let aside: ReactNode = null;
  if (decidable) {
    aside = (
      <DecideForm
        targetKey={view.targetKey}
        targetType={type}
        role={staff.role}
        priorities={view.open.map((report) => report.priority)}
        strikes={view.owner?.strikes ?? null}
        openCount={view.open.length}
        ai={view.ai}
      />
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <Link href="/signalements" className={`self-start text-sm ${linkClassName}`}>
          Retour aux signalements
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 dir="auto" className="text-2xl font-semibold text-balance">
            {title}
          </h1>
          {status ? <Badge variant="neutral">{status}</Badge> : null}
          {first ? <LiveSlaTimer dueAt={first.slaDueAt} renderedAt={renderedAt} windowMs={prioritySla(first.priority)} /> : null}
        </div>
        <p className="text-sm text-foreground-muted">
          {view.open.length > 0 ? `${plural(view.open.length, "signalement ouvert", "signalements ouverts")}, priorité ${first?.priority}.` : "Aucun signalement ouvert."} Référence {view.targetKey}.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div className="flex flex-col gap-6">
          <Panel title="Contenu signalé">
            <Content snapshot={view.snapshot} site={site} />
          </Panel>
          <Panel title="Signalements ouverts" meta={view.open.length > 0 ? plural(view.open.length, "signalement", "signalements") : null}>
            {view.open.length > 0 ? (
              <ul className="flex flex-col divide-y divide-border">
                {view.open.map((report) => (
                  <OpenReport key={report.id} report={report} renderedAt={renderedAt} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-foreground-muted">Tous les signalements de ce contenu sont clos.</p>
            )}
          </Panel>
          <Panel title="Historique">
            <History view={view} />
          </Panel>
        </div>

        <aside className="flex flex-col gap-6" aria-label="Décision et compte concerné">
          {view.ai ? <AiProposalPanel ai={view.ai} templateLabel={decidable ? (aiTemplate(view.ai, type)?.label ?? null) : null} /> : null}
          {aside}
          {view.owner ? (
            <Panel title="Compte concerné">
              <Facts
                rows={[
                  [
                    "Nom",
                    <Link key="owner" href={`/comptes/${view.owner.uid}`} dir="auto" className={linkClassName}>
                      {view.owner.displayName}
                    </Link>,
                  ],
                  ["Type", view.owner.type === "pro" ? "Professionnel" : "Particulier"],
                  ["État", ACCOUNT_STATUS_LABEL[view.owner.status] ?? view.owner.status],
                  ["Échelle", STRIKE_LABEL[Math.min(3, Math.max(0, view.owner.strikes))]],
                  ["Inscrit le", formatDateTime(view.owner.createdAt)],
                ]}
              />
            </Panel>
          ) : null}
        </aside>
      </div>
    </>
  );
}
