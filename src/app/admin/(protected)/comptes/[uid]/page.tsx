import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { requirePageStaff } from "@/lib/auth/current-user";
import type { UserModerationView } from "@/lib/decisions/contracts";
import { userModerationView } from "@/lib/decisions/users";
import { serverEnv } from "@/lib/env";
import { cn } from "@/lib/utils";
import { ACCOUNT_STATUS_LABEL, APPEAL_STATUS_LABEL, formatDateTime, plural, TARGET_LABEL, targetHref, templateLabel } from "../../../_lib/moderation-format";
import { SANCTION_LABEL, stepChoice } from "../../../_components/decide-state";
import { Facts, linkClassName, Panel } from "../../../_components/panel";
import { RevokePhoneButton } from "../../../_components/revoke-phone-button";

// An account's moderation page (design D14, D15, D24): the sanctions ladder and where it stands,
// the running suspension, its accuracy as a reporter (art. 23), and the decisions about it.

export const metadata: Metadata = { title: "Compte" };

const STEPS = ["Averti", "Suspendu 7 jours", "Suspendu 30 jours", "Fermé"] as const;

/** The ladder as four steps, those reached filled (a ban fills them all). */
function Ladder({ user }: { user: UserModerationView }) {
  const reached = user.status === "banned" ? 4 : Math.min(3, Math.max(0, user.strikes.level));
  return (
    <ol aria-label={`Échelle des sanctions : ${reached === 0 ? "aucune sanction" : STEPS[reached - 1]}`} className="grid grid-cols-4 gap-1.5">
      {STEPS.map((step, index) => {
        const done = index < reached;
        return (
          <li key={step} aria-current={index === reached - 1 ? "step" : undefined} className="flex flex-col gap-1.5">
            <span aria-hidden="true" className={cn("h-2 rounded-full", done ? (index === 3 ? "bg-danger" : index === 0 ? "bg-featured" : "bg-primary") : "bg-surface-muted ring-1 ring-border ring-inset")} />
            <span className={cn("text-xs", done ? "font-medium text-foreground" : "text-foreground-muted")}>{step}</span>
          </li>
        );
      })}
    </ol>
  );
}

function share(value: number | null): string {
  return value === null ? "aucun signalement décidé" : `${Math.round(value * 100)} % de signalements fondés`;
}

export default async function AccountPage({ params }: { params: Promise<{ uid: string }> }) {
  await requirePageStaff(["moderator", "admin"]);
  const { uid } = await params;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) notFound();
  const user = await userModerationView(uid);
  if (!user) notFound();
  const site = serverEnv().SITE_URL.replace(/\/$/, "");
  const { reporter } = user;

  return (
    <>
      <div className="flex flex-col gap-2">
        <Link href="/comptes" className={`self-start text-sm ${linkClassName}`}>
          Chercher un autre compte
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 dir="auto" className="text-2xl font-semibold text-balance">
            {user.displayName}
          </h1>
          <Badge variant={user.status === "active" ? "success" : user.status === "banned" ? "danger" : "warning"}>{ACCOUNT_STATUS_LABEL[user.status] ?? user.status}</Badge>
        </div>
        <p className="text-sm text-foreground-muted">
          Inscrit le {formatDateTime(user.createdAt)}.{" "}
          <a href={`${site}/fr/profil/${user.publicId}`} target="_blank" rel="noopener noreferrer" className={linkClassName}>
            Profil public
          </a>
          {", "}
          <Link href={targetHref(`user:${user.uid}`)} className={linkClassName}>
            signalements visant ce compte
          </Link>
          .
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        <Panel title="Sanctions">
          <Ladder user={user} />
          <Facts
            rows={[
              ["Dernière sanction", user.strikes.lastAt ? formatDateTime(user.strikes.lastAt) : "Aucune"],
              ["Suspension", user.suspension ? `Jusqu'au ${formatDateTime(user.suspension.until)}` : "Aucune en cours"],
              ["Étape proposée", user.status === "banned" ? "Compte déjà fermé" : SANCTION_LABEL[stepChoice(user.nextStep)]],
            ]}
          />
          {user.suspension ? (
            <Link href={`/decisions/${user.suspension.decisionId}`} className={`self-start text-sm ${linkClassName}`}>
              Décision de suspension
            </Link>
          ) : null}
        </Panel>

        <Panel title="Téléphone">
          <Facts rows={[["Numéro vérifié", user.phone.verified ? (user.phone.verifiedAt ? `Oui, depuis le ${formatDateTime(user.phone.verifiedAt)}` : "Oui") : "Non"]]} />
          {user.phone.verified ? <RevokePhoneButton uid={user.uid} name={user.displayName} /> : null}
        </Panel>

        <Panel title="Comme signalant">
          <Facts
            rows={[
              ["Signalements", String(reporter.total)],
              ["Fiabilité récente", `${share(reporter.foundedShare)}${reporter.recent.length > 0 ? ` sur les ${reporter.recent.length} derniers décidés` : ""}`],
              ["Manifestement infondés", `${reporter.manifestRecent} sur 30 jours`],
              ["Averti pour abus", reporter.warnedAt ? `Le ${formatDateTime(reporter.warnedAt)}` : "Non"],
              ["Signalements suspendus", reporter.abusiveUntil ? `Jusqu'au ${formatDateTime(reporter.abusiveUntil)}` : "Non"],
            ]}
          />
        </Panel>
      </div>

      <Panel title="Décisions" meta={user.decisions.length > 0 ? plural(user.decisions.length, "décision", "décisions") : null}>
        {user.decisions.length === 0 ? (
          <p className="text-sm text-foreground-muted">Aucune décision sur ce compte ni sur ses contenus.</p>
        ) : (
          <div role="region" aria-label="Décisions du compte" tabIndex={0} className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead className="text-start text-foreground-muted">
                <tr>
                  <th scope="col" className="py-2 pe-4 text-start font-medium">Décision</th>
                  <th scope="col" className="py-2 pe-4 text-start font-medium">Cible</th>
                  <th scope="col" className="py-2 pe-4 text-start font-medium">Date</th>
                  <th scope="col" className="py-2 text-start font-medium">Recours</th>
                </tr>
              </thead>
              <tbody>
                {user.decisions.map((decision) => (
                  <tr key={decision.id} className="border-t border-border align-top">
                    <td className="py-2 pe-4">
                      <Link href={`/decisions/${decision.id}`} className={linkClassName}>
                        {templateLabel(decision.templateId)}
                      </Link>
                    </td>
                    <td className="py-2 pe-4 text-foreground-muted">
                      {TARGET_LABEL[decision.target.type] ?? decision.target.type} {decision.target.type === "user" ? "" : decision.target.id}
                    </td>
                    <td className="py-2 pe-4 whitespace-nowrap tabular-nums">{formatDateTime(decision.createdAt)}</td>
                    <td className="py-2 text-foreground-muted">{decision.appeal ? (APPEAL_STATUS_LABEL[decision.appeal as keyof typeof APPEAL_STATUS_LABEL] ?? decision.appeal) : "Aucun"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
