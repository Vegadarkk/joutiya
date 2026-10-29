import type { Metadata } from "next";
import { requirePageStaff } from "@/lib/auth/current-user";
import { sellerPaymentsAdmin } from "@/lib/pro/seller-payment";
import { SellerPaymentsAdmin } from "../../../_components/seller-payments-admin";

// « Payer chez le vendeur » (design phase-7/boutique-temporaire.md §2): allowed payment hosts and
// the links waiting for a host's review. Admins only; every change is journaled.

export const metadata: Metadata = { title: "Paiement chez le vendeur" };

export default async function SellerPaymentsPage() {
  await requirePageStaff(["admin"]);
  const view = await sellerPaymentsAdmin();
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Paiement chez le vendeur</h1>
        <p className="mt-1 max-w-prose text-sm text-foreground-muted">
          Les boutiques vérifiées peuvent relier leurs annonces à leur propre page de paiement. Seuls les domaines de cette liste sont affichés ; un nouveau domaine attend votre vérification. Aalan ne reçoit jamais l&apos;argent et ne prend aucune commission.
        </p>
      </div>
      <SellerPaymentsAdmin initial={view} />
    </>
  );
}
