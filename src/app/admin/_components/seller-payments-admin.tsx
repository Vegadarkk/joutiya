"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SELLER_PAYMENT_API, type SellerPaymentsAdminView } from "@/lib/contracts/seller-payment";
import { adminFetch, errorMessage } from "./api-client";

// « Payer chez le vendeur » in the back office (design phase-7/boutique-temporaire.md §2): the hosts
// an admin has checked belong to a licensed payment provider, and the links waiting for a host's
// review. Approving adds the host (its links turn active 24 h after their save); rejecting drops
// the links of that host and tells their owners why. Taking a host off the list hides its buttons.

const MESSAGES: Record<string, string> = { invalid_body: "Liste invalide : un nom de domaine par ligne (ex. paiement.banque.ma), sans https:// ni chemin." };
const dateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Casablanca" });

export function SellerPaymentsAdmin({ initial }: { initial: SellerPaymentsAdminView }) {
  const router = useRouter();
  const [hosts, setHosts] = useState(initial.hosts.join("\n"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  async function saveHosts() {
    setError(null);
    setBusy("hosts");
    try {
      const list = hosts.split(/\s+/).map((host) => host.trim().toLowerCase()).filter(Boolean);
      const next = await adminFetch<SellerPaymentsAdminView>(SELLER_PAYMENT_API.admin, { method: "PUT", body: { hosts: list }, csrf: true });
      if (next) setHosts(next.hosts.join("\n"));
      toast.success("Liste des domaines enregistrée");
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
    } finally {
      setBusy(null);
    }
  }

  async function review(host: string, decision: "approve" | "reject") {
    setError(null);
    const reason = reasons[host]?.trim();
    if (decision === "reject" && (!reason || reason.length < 3)) {
      setError("Indiquez le motif du refus : il est envoyé aux boutiques.");
      return;
    }
    setBusy(`${decision}-${host}`);
    try {
      const next = await adminFetch<SellerPaymentsAdminView>(SELLER_PAYMENT_API.adminReview, { method: "POST", body: { host, decision, ...(decision === "reject" ? { reason } : {}) }, csrf: true });
      // The list as stored now: an approval adds the host, and the next save must keep it.
      if (next) setHosts(next.hosts.join("\n"));
      toast.success(decision === "approve" ? `${host} ajouté à la liste` : `Liens vers ${host} refusés`);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
    } finally {
      setBusy(null);
    }
  }

  const byHost = new Map<string, SellerPaymentsAdminView["queue"]>();
  for (const item of initial.queue) byHost.set(item.host, [...(byHost.get(item.host) ?? []), item]);

  return (
    <div className="flex flex-col gap-8">
      {error ? <ErrorBanner title={error} /> : null}
      <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
        <h2 className="text-lg font-semibold">Domaines à vérifier ({initial.queue.length})</h2>
        {byHost.size === 0 ? (
          <p className="text-sm text-foreground-muted">Aucun lien en attente.</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {[...byHost.entries()].map(([host, items]) => (
              <li key={host} className="flex flex-col gap-3 rounded-md border border-border p-4">
                <p className="font-mono text-sm font-semibold" dir="ltr">
                  {host}
                </p>
                <ul className="flex flex-col gap-1 text-sm">
                  {items.map((item) => (
                    <li key={item.proId} className="flex flex-wrap gap-x-3">
                      <a href={`/pros/${item.proId}`} className="font-medium text-link underline underline-offset-2" dir="auto">
                        {item.shopName}
                      </a>
                      <span className="break-all font-mono text-foreground-muted" dir="ltr">
                        {item.url}
                      </span>
                      <span className="text-foreground-muted">depuis le {dateTime.format(new Date(item.since))}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-sm text-foreground-muted">
                  Vérifiez que ce domaine appartient à une banque ou à un prestataire de paiement agréé (Bank Al-Maghrib) avant de l&apos;accepter. N&apos;ouvrez pas le lien sans précaution.
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input aria-label={`Motif de refus pour ${host}`} placeholder="Motif en cas de refus" value={reasons[host] ?? ""} maxLength={500} onChange={(event) => setReasons((current) => ({ ...current, [host]: event.target.value }))} />
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" loading={busy === `reject-${host}`} onClick={() => void review(host, "reject")}>
                      Refuser
                    </Button>
                    <Button type="button" variant="structure" size="sm" loading={busy === `approve-${host}`} onClick={() => void review(host, "approve")}>
                      Accepter le domaine
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
        <h2 className="text-lg font-semibold">Domaines autorisés ({initial.hosts.length})</h2>
        <p className="text-sm text-foreground-muted">
          Un nom de domaine exact par ligne, sans joker. Retirer un domaine masque aussitôt les boutons qui y mènent (les autres serveurs suivent dans les 5 minutes).
        </p>
        <textarea
          aria-label="Domaines autorisés"
          dir="ltr"
          rows={8}
          spellCheck={false}
          value={hosts}
          onChange={(event) => setHosts(event.target.value)}
          className="w-full rounded-md border border-border-control bg-surface px-3 py-2 font-mono text-sm"
        />
        <div className="flex justify-end">
          <Button type="button" variant="structure" loading={busy === "hosts"} onClick={() => void saveHosts()}>
            Enregistrer la liste
          </Button>
        </div>
      </section>
    </div>
  );
}
