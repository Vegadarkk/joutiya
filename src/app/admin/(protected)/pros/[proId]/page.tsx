import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cityBySlug, cityName } from "@/config/regions";
import { requirePageStaff } from "@/lib/auth/current-user";
import { displayPhone } from "@/lib/phone/normalize";
import { proIdSchema } from "@/lib/pro/profile-schema";
import type { ProReview as ProReviewView } from "@/lib/contracts/pro";
import { proReview } from "@/lib/pro/review";
import { shopPaymentAdmin } from "@/lib/pro/seller-payment";
import { shopSocialAdmin } from "@/lib/pro/social-links";
import { ProDecisionForm, ProEffectsRerun } from "../../../_components/pro-decision-form";
import { IDENTIFIER_LABEL, LEGAL_FORM_LABEL, LIFECYCLE_LABEL, PHONE_OUTCOME_LABEL, RENTAL_CHECK_ISSUE_LABEL, RENTAL_CHECK_STATUS_LABEL, formatIce } from "../../../_components/pro-labels";
import { ProPhoneCheckForm } from "../../../_components/pro-phone-check-form";
import { RentalCheckDecisionForm } from "../../../_components/rental-check-decision-form";
import { ShopPaymentPanel } from "../../../_components/shop-payment-panel";
import { ShopSocialPanel } from "../../../_components/shop-social-panel";

// Review of one Pro application (phase 7 design §4): the shop, the legal identifiers to check
// against the registry, the KYBC pieces (each opening is journaled), the applicant's account, the
// phone call while WhatsApp is unavailable, and the decision while the application is pending. For
// a car rental agency, its licence document and what the AI check read on it (decision 5), with
// the moderator's decision when the check left it in doubt.

export const metadata: Metadata = { title: "Vérifier une demande Pro" };

const dateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Casablanca" });
const date = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeZone: "Africa/Casablanca" });

const PIECE_TYPE: Record<string, string> = { "application/pdf": "PDF", "image/jpeg": "Image JPEG", "image/png": "Image PNG" };
const REGISTRY_LABEL: Record<string, string> = { ompic: "OMPIC", directinfo: "DirectInfo", odco: "ODCo" };

/** Points the moderator checks before validating (design §4); the CNIE line follows audit C2-03. */
const CHECKLIST = [
  "Le nom, l'ICE et le RC (ou le n° d'auto-entrepreneur, la TP, le n° de coopérative) correspondent au registre consulté.",
  "Le justificatif est lisible, récent et au nom de la boutique ou du demandeur.",
  "L'activité déclarée est cohérente avec les annonces du compte.",
  "Un justificatif laisse voir un numéro de CNIE : refusez avec le motif « envoyez une copie où le numéro de CNIE est masqué ».",
];

function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-foreground-muted">{label}</dt>
          <dd className="break-words text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "taille inconnue";
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1).replace(".", ",")} Mo` : `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

export default async function ProReviewPage({ params }: { params: Promise<{ proId: string }> }) {
  await requirePageStaff(["moderator", "admin"]);
  const id = proIdSchema.safeParse((await params).proId);
  if (!id.success) notFound();
  const [review, payment, social] = await Promise.all([proReview(id.data), shopPaymentAdmin(id.data).catch(() => null), shopSocialAdmin(id.data).catch(() => null)]);
  if (!review) notFound();

  const city = cityBySlug(review.citySlug);
  const pending = review.kybc.status === "submitted" && review.lifecycle === "pending_verification";
  const owner = review.owner;
  const phoneVerified = owner?.phoneVerified === true;
  const { form, ...identifiers } = review.legal;
  const check = review.kybc.phoneCheck;

  return (
    <>
      <div className="flex flex-col gap-2">
        <Link href="/pros" className="text-sm font-medium text-link underline-offset-2 hover:underline">
          Retour aux demandes
        </Link>
        <h1 className="text-2xl font-semibold break-words" dir="auto">
          {review.name}
        </h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={pending ? "warning" : review.lifecycle === "rejected" ? "danger" : "success"}>{LIFECYCLE_LABEL[review.lifecycle] ?? review.lifecycle}</Badge>
          {review.kybc.submittedAt ? <span className="text-foreground-muted">Envoyée le {dateTime.format(new Date(review.kybc.submittedAt))}</span> : null}
          {review.effectsPending ? <Badge variant="danger">Effets de la validation en attente</Badge> : null}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <article className="flex flex-col gap-6">
          <Panel title="Boutique">
            <Facts
              rows={[
                ["Nom", <span key="name" dir="auto">{review.name}</span>],
                ["Ville", city ? cityName(city, "fr") : review.citySlug],
                ["Présentation", review.description ? <span key="description" dir="auto" className="whitespace-pre-line">{review.description}</span> : "Aucune"],
              ]}
            />
          </Panel>

          <Panel title="Identifiants légaux">
            <Facts
              rows={[
                ["Forme", LEGAL_FORM_LABEL[form ?? ""] ?? form ?? "Inconnue"],
                ...Object.entries(identifiers).map(([key, value]): [string, ReactNode] => [
                  IDENTIFIER_LABEL[key] ?? key,
                  <span key={key} className="font-mono tabular-nums" dir="ltr">
                    {key === "ice" ? formatIce(value) : value}
                  </span>,
                ]),
              ]}
            />
            {review.kybc.iceFormatOk ? null : <p className="text-sm text-warning">L’ICE ne compte pas 15 chiffres : vérifiez-le au registre avant toute validation.</p>}
            <p className="text-sm text-foreground-muted">
              Consultez le registre de l’OMPIC ou DirectInfo et notez celui utilisé dans la décision.
              {review.kybc.registrySource ? ` Registre noté : ${REGISTRY_LABEL[review.kybc.registrySource] ?? review.kybc.registrySource}.` : ""}
            </p>
          </Panel>

          <Panel title="Justificatifs">
            <p className="text-sm text-foreground-muted">Chaque ouverture est journalisée à votre nom. Les PDF se téléchargent, les images s’ouvrent dans un nouvel onglet.</p>
            <ul className="flex flex-col gap-2" data-testid="pro-pieces">
              {review.pieces.map((piece, index) => (
                <li key={piece.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2.5 text-sm">
                  <span className="flex flex-col">
                    <span className="font-medium">Justificatif {index + 1}</span>
                    <span className="text-foreground-muted">
                      {PIECE_TYPE[piece.declaredType] ?? piece.declaredType}, {formatSize(piece.size)}
                    </span>
                  </span>
                  {piece.status === "ready" ? (
                    <a href={`/kybc/${review.proId}/${piece.id}`} target="_blank" rel="noopener noreferrer" className="font-medium text-link underline underline-offset-2">
                      Ouvrir
                    </a>
                  ) : (
                    <Badge variant="warning">Fichier indisponible</Badge>
                  )}
                </li>
              ))}
            </ul>
          </Panel>

          {review.rentalCheck ? <RentalCheckPanel proId={review.proId} check={review.rentalCheck} ice={review.legal["ice"] ?? ""} /> : null}

          <Panel title="Points à vérifier">
            <ul className="flex list-disc flex-col gap-1.5 ps-5 text-sm">
              {CHECKLIST.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Panel>
        </article>

        <aside className="flex flex-col gap-6" aria-label="Demandeur, appel et décision">
          {payment && (payment.url || payment.pendingUrl || payment.cashOnDelivery || payment.suspended) ? (
            <Panel title="Paiement chez le vendeur">
              <ShopPaymentPanel proId={review.proId} initial={payment} />
            </Panel>
          ) : null}
          {social && (social.links.length > 0 || social.hidden) ? (
            <Panel title="Réseaux sociaux">
              <ShopSocialPanel proId={review.proId} initial={social} />
            </Panel>
          ) : null}
          <Panel title="Demandeur">
            {owner ? (
              <Facts
                rows={[
                  ["Nom affiché", <span key="owner" dir="auto">{owner.displayName}</span>],
                  ["Profil", <span key="public" className="font-mono" dir="ltr">{owner.publicId}</span>],
                  ["Compte", owner.status === "active" ? "Actif" : owner.status],
                  ["Inscrit le", date.format(new Date(owner.createdAt))],
                  ["E-mail", owner.emailVerified ? "Vérifié" : "Non vérifié"],
                  ["Téléphone", phoneVerified ? "Vérifié" : "Non vérifié"],
                ]}
              />
            ) : (
              <p className="text-sm text-danger">Le compte du demandeur n’existe plus : refusez la demande.</p>
            )}
          </Panel>

          {owner && (!phoneVerified || check) ? (
            <Panel title="Appel de vérification">
              {owner.phoneToCheck ? (
                <p className="text-sm">
                  Numéro déclaré :{" "}
                  <a href={`tel:${owner.phoneToCheck}`} className="font-mono font-medium text-link underline underline-offset-2" dir="ltr">
                    {displayPhone(owner.phoneToCheck)}
                  </a>
                </p>
              ) : null}
              {check ? (
                <p className="rounded-md bg-surface-muted p-3 text-sm">
                  Dernier appel le {dateTime.format(new Date(check.at))} au <span dir="ltr">{displayPhone(check.phone)}</span> : {PHONE_OUTCOME_LABEL[check.outcome] ?? check.outcome}.
                  {check.note ? <span className="mt-1 block text-foreground-muted" dir="auto">{check.note}</span> : null}
                </p>
              ) : null}
              {pending && !phoneVerified ? <ProPhoneCheckForm proId={review.proId} declared={owner.phoneToCheck} /> : null}
            </Panel>
          ) : null}

          {pending && review.kybc.submittedAt ? (
            <ProDecisionForm proId={review.proId} submittedAt={review.kybc.submittedAt} phoneVerified={phoneVerified} ownerActive={owner?.status === "active"} />
          ) : review.effectsPending && review.kybc.submittedAt && review.kybc.registrySource ? (
            <ProEffectsRerun proId={review.proId} submittedAt={review.kybc.submittedAt} registrySource={review.kybc.registrySource} />
          ) : review.kybc.rejectReason ? (
            <Panel title="Motif du refus">
              <p className="text-sm whitespace-pre-line" dir="auto">
                {review.kybc.rejectReason}
              </p>
            </Panel>
          ) : null}
        </aside>
      </div>
    </>
  );
}

const CHECK_VARIANT: Record<string, "warning" | "danger" | "success"> = { pending: "warning", review: "warning", verified: "success", rejected: "danger" };

function RentalCheckPanel({ proId, check, ice }: { proId: string; check: NonNullable<ProReviewView["rentalCheck"]>; ice: string }) {
  const read = check.extracted;
  const open = check.status === "review" || check.status === "pending";
  return (
    <section id="agrement" data-testid="rental-check-review" className="flex scroll-mt-6 flex-col gap-3 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Agrément de location</h2>
        <Badge variant={CHECK_VARIANT[check.status] ?? "warning"}>{RENTAL_CHECK_STATUS_LABEL[check.status] ?? check.status}</Badge>
      </div>
      <p className="text-sm text-foreground-muted">
        Envoyé le {dateTime.format(new Date(check.submittedAt))}.
        {check.checkedAt ? ` ${check.method === "ai" ? "Contrôlé par la lecture IA" : "Décidé par un modérateur"} le ${dateTime.format(new Date(check.checkedAt))}.` : ""}
      </p>
      <Facts
        rows={[
          ["Numéro déclaré", <span key="declared" className="font-mono tabular-nums" dir="ltr">{check.agrementRef}</span>],
          ["ICE de la boutique", <span key="ice" className="font-mono tabular-nums" dir="ltr">{formatIce(ice)}</span>],
          ...(read
            ? ([
                ["Numéro lu", read.reference ? <span key="reference" className="font-mono tabular-nums" dir="ltr">{read.reference}</span> : "Absent"],
                ["Bénéficiaire lu", read.companyName ? <span key="company" dir="auto">{read.companyName}</span> : "Absent"],
                ["ICE lu", read.ice ? <span key="read-ice" className="font-mono tabular-nums" dir="ltr">{formatIce(read.ice)}</span> : "Absent"],
                ["Date lue", read.decisionDate || "Absente"],
              ] as [string, ReactNode][])
            : []),
        ]}
      />
      {check.issues.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm" data-testid="rental-check-issues">
          {check.issues.map((issue) => (
            <li key={issue} className="text-warning">
              {RENTAL_CHECK_ISSUE_LABEL[issue] ?? issue}
            </li>
          ))}
        </ul>
      ) : null}
      {read && read.signs.length > 0 ? (
        <div className="rounded-md bg-surface-muted p-3 text-sm">
          <p className="font-medium">Signes relevés par la lecture IA</p>
          <ul className="mt-1 flex list-disc flex-col gap-0.5 ps-5">
            {read.signs.map((sign) => (
              <li key={sign} dir="auto">
                {sign}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {read?.note ? (
        <p className="text-sm text-foreground-muted" dir="auto">
          Note de la lecture IA : {read.note}
        </p>
      ) : null}
      {check.piece?.status === "ready" ? (
        <a href={`/kybc/${proId}/${check.piece.id}`} target="_blank" rel="noopener noreferrer" className="w-fit text-sm font-medium text-link underline underline-offset-2">
          Ouvrir le document ({PIECE_TYPE[check.piece.declaredType] ?? check.piece.declaredType}, {formatSize(check.piece.size)})
        </a>
      ) : (
        <Badge variant="warning">Fichier indisponible</Badge>
      )}
      <p className="text-xs text-foreground-muted">
        Aucune vérification en ligne de l’authenticité n’existe : vérifiez la cohérence du numéro, du bénéficiaire (ICE ou raison sociale) et de la date, et l’absence de retouche.
      </p>
      {check.status === "rejected" && check.reason ? (
        <p className="rounded-md bg-surface-muted p-3 text-sm whitespace-pre-line" dir="auto">
          Motif du refus : {check.reason}
        </p>
      ) : null}
      {open ? <RentalCheckDecisionForm proId={proId} submittedAt={check.submittedAt} /> : null}
    </section>
  );
}
