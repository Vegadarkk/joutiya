"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SELLER_PAYMENT_API, type ShopPaymentAdminView } from "@/lib/contracts/seller-payment";
import { adminFetch, errorMessage } from "./api-client";

// A shop's « Payer chez le vendeur » button (report « Lien de paiement suspect »): the moderator
// suspends it with a reason sent to the owner, or restores it. The listings are not touched.

const MESSAGES: Record<string, string> = { conflict: "Cette boutique n'a pas de bouton de paiement." };

export function ShopPaymentPanel({ proId, initial }: { proId: string; initial: ShopPaymentAdminView }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const suspended = initial.suspended !== null;

  async function act() {
    setError(null);
    if (reason.trim().length < 3) {
      setError("Indiquez le motif : il est envoyé à la boutique et inscrit au journal.");
      return;
    }
    setBusy(true);
    try {
      await adminFetch<ShopPaymentAdminView>(SELLER_PAYMENT_API.adminShop(proId), { method: "POST", body: { action: suspended ? "restore" : "suspend", reason: reason.trim() }, csrf: true });
      toast.success(suspended ? "Bouton de paiement rétabli" : "Bouton de paiement suspendu");
      setReason("");
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p>
        Lien actif :{" "}
        {initial.url ? (
          <span className="break-all font-mono" dir="ltr">
            {initial.url}
          </span>
        ) : (
          "aucun"
        )}
      </p>
      {initial.pendingUrl ? (
        <p>
          Lien en attente :{" "}
          <span className="break-all font-mono" dir="ltr">
            {initial.pendingUrl}
          </span>
        </p>
      ) : null}
      <p>Paiement à la livraison : {initial.cashOnDelivery ? "oui" : "non"}</p>
      {initial.suspended ? <p className="text-danger">Suspendu : {initial.suspended.reason}</p> : null}
      {error ? <ErrorBanner title={error} /> : null}
      <Input aria-label="Motif" placeholder={suspended ? "Motif du rétablissement" : "Motif de la suspension"} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
      <Button type="button" variant={suspended ? "outline" : "danger"} size="sm" loading={busy} onClick={() => void act()}>
        {suspended ? "Rétablir le bouton" : "Suspendre le bouton"}
      </Button>
    </div>
  );
}
