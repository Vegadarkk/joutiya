import type { Metadata } from "next";
import { GUIDE_PROCEDURE_IDS, GUIDE_PROCEDURES, GUIDE_SOURCE_IDS, GUIDE_SOURCES, guideRubricCard, guideSourceLabel, sourceDomain, type GuideRubric, type GuideSourceId } from "@/content/guide";
import { Badge } from "@/components/ui/badge";
import { requirePageStaff } from "@/lib/auth/current-user";
import { isFirestoreConfigured } from "@/lib/firebase/admin";
import { CHANGE_THRESHOLD_BITS, changeDistance, linkFlags, type LinkFlag, type LinkOutcome } from "@/lib/guide/check";
import { readGuideState, type GuideState } from "@/lib/guide/state";
import { logger } from "@/lib/logging/logger";
import { formatDate, formatDateTime } from "../../_lib/moderation-format";
import { linkClassName } from "../../_components/panel";
import { GuideLinkAccept } from "../../_components/guide-link-accept";

// Links of the admin procedures guide (design guide-demarches G4): what the weekly checker saw for
// each official source, why one needs a look, and "Marquer comme vérifié" once a person has read the
// page. Fixing a link (new address, page gone) is a change of src/content/guide/sources.ts.

export const metadata: Metadata = { title: "Guide des démarches" };

const OUTCOME: Record<LinkOutcome, { label: string; variant: "success" | "warning" | "danger" | "neutral" }> = {
  ok: { label: "En ligne", variant: "success" },
  redirected: { label: "Redirigé", variant: "warning" },
  offsite: { label: "Hors site officiel", variant: "danger" },
  broken: { label: "En échec", variant: "danger" },
  "soft-error": { label: "Maintenance ou page vide", variant: "danger" },
  blocked: { label: "Refusé au robot", variant: "neutral" },
  unreachable: { label: "Injoignable", variant: "neutral" },
};

const FLAG: Record<LinkFlag, string> = {
  failing: "À corriger dans le registre",
  blocked: "À contrôler à la main",
  changed: "Page modifiée : relire",
  "review-due": "Relecture humaine due",
  unconfirmed: "Jamais vu en ligne : masqué",
};

function rubricsOf(id: GuideSourceId): GuideRubric[] {
  return [...new Set(GUIDE_PROCEDURE_IDS.filter((procedure) => (GUIDE_PROCEDURES[procedure].sources as readonly string[]).includes(id)).map((procedure) => GUIDE_PROCEDURES[procedure].rubric))];
}

async function loadState(): Promise<GuideState | null> {
  if (!isFirestoreConfigured()) return { runAt: null, links: {} };
  try {
    return await readGuideState();
  } catch (error) {
    logger.error({ err: (error as Error).message }, "system/guide-links unreadable");
    return null;
  }
}

export default async function GuideLinksPage() {
  await requirePageStaff(["moderator", "admin"]);
  const state = await loadState();
  const now = new Date();
  const rows = GUIDE_SOURCE_IDS.map((id) => {
    const link = state?.links[id];
    const current = link?.url === GUIDE_SOURCES[id].url ? link : undefined;
    return { id, current, flags: linkFlags(GUIDE_SOURCES[id], current, now) };
  }).sort((a, b) => b.flags.length - a.flags.length);
  const flagged = rows.filter((row) => row.flags.length > 0).length;

  return (
    <>
      <div>
        <h1 id="guide-title" className="text-2xl font-semibold">
          Liens du guide des démarches
        </h1>
        <p className="mt-1 max-w-prose text-sm text-foreground-muted">
          {state === null
            ? "État du contrôle illisible pour le moment. Rechargez la page dans un instant."
            : state.runAt
              ? `Dernier contrôle automatique le ${formatDateTime(state.runAt)}, chaque lundi. ${flagged === 0 ? "Aucun lien à revoir." : `${flagged} lien${flagged > 1 ? "s" : ""} à revoir.`}`
              : "Aucun contrôle encore : le premier a lieu lundi à 6 h 10 UTC."}{" "}
          Une page modifiée au-delà de {CHANGE_THRESHOLD_BITS} bits d&apos;empreinte est signalée ; relisez-la, puis marquez-la comme vérifiée.
        </p>
      </div>
      <div role="region" aria-labelledby="guide-title" tabIndex={0} className="overflow-x-auto rounded-lg border border-border bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <table className="w-full min-w-[56rem] text-sm">
          <thead className="bg-surface-muted text-start text-foreground-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5 text-start font-medium">Source</th>
              <th scope="col" className="px-4 py-2.5 text-start font-medium">Rubriques</th>
              <th scope="col" className="px-4 py-2.5 text-start font-medium">État</th>
              <th scope="col" className="px-4 py-2.5 text-start font-medium">Relu le</th>
              <th scope="col" className="px-4 py-2.5 text-start font-medium">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ id, current, flags }) => {
              const source = GUIDE_SOURCES[id];
              const label = guideSourceLabel("fr", id);
              const distance = changeDistance(current);
              const reviewed = [source.reviewedAt, current?.acceptedAt?.slice(0, 10)].filter(Boolean).sort().at(-1);
              return (
                <tr key={id} className="border-t border-border align-top">
                  <th scope="row" className="px-4 py-3 text-start font-normal">
                    <a href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className={`font-medium ${linkClassName}`}>
                      {label}
                    </a>
                    <span className="block text-xs text-foreground-muted">
                      {sourceDomain(id)} ({id}){source.confirmed ? "" : ", non confirmé"}
                    </span>
                  </th>
                  <td className="px-4 py-3 text-foreground-muted">{rubricsOf(id).map((rubric) => guideRubricCard("fr", rubric).title).join(", ") || "Accueil du guide"}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {current ? <Badge variant={OUTCOME[current.outcome].variant}>{OUTCOME[current.outcome].label}</Badge> : <Badge>Pas encore contrôlé</Badge>}
                      {flags.map((flag) => (
                        <Badge key={flag} variant="warning">
                          {FLAG[flag]}
                        </Badge>
                      ))}
                    </div>
                    {current ? (
                      <p className="mt-1.5 text-xs break-all text-foreground-muted">
                        {current.detail}
                        {current.streak > 1 ? `, ${current.streak} contrôles de suite` : ""}
                        {distance !== null && distance > 0 ? `, écart ${distance} bits` : ""}, le {formatDate(current.checkedAt)}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-foreground-muted">{reviewed ? formatDate(`${reviewed}T12:00:00Z`) : ""}</td>
                  <td className="px-4 py-3 text-end">{current ? <GuideLinkAccept id={id} label={label} /> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
