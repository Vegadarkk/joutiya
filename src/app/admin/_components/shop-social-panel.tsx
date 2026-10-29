"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PRO_SOCIAL_ADMIN_API, type ProSocialView } from "@/lib/contracts/pro";
import { adminFetch, errorMessage } from "./api-client";

// A shop's social links (report « Lien de réseau social suspect »): the moderator hides them all
// with a reason sent to the owner, or restores them. The storefront and listings are not touched.

const MESSAGES: Record<string, string> = { conflict: "Cette boutique n'a pas de réseaux sociaux." };

const NETWORKS: Record<ProSocialView["links"][number]["network"], string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  facebook: "Facebook",
  youtube: "YouTube",
  x: "X",
  linkedin: "LinkedIn",
  snapchat: "Snapchat",
  whatsapp: "WhatsApp Business",
};

export function ShopSocialPanel({ proId, initial }: { proId: string; initial: ProSocialView }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hidden = initial.hidden !== null;

  async function act() {
    setError(null);
    if (reason.trim().length < 3) {
      setError("Indiquez le motif : il est envoyé à la boutique et inscrit au journal.");
      return;
    }
    setBusy(true);
    try {
      await adminFetch<ProSocialView>(PRO_SOCIAL_ADMIN_API(proId), { method: "POST", body: { action: hidden ? "restore" : "hide", reason: reason.trim() }, csrf: true });
      toast.success(hidden ? "Réseaux sociaux rétablis" : "Réseaux sociaux masqués");
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
      <ul className="flex flex-col gap-1.5">
        {initial.links.map((link) => (
          <li key={link.network} className="flex flex-wrap gap-x-2">
            <span className="font-medium">{NETWORKS[link.network]}</span>
            <a href={link.href} target="_blank" rel="nofollow ugc noopener noreferrer" referrerPolicy="no-referrer" className="break-all font-mono text-link underline underline-offset-2" dir="ltr">
              {link.href}
            </a>
          </li>
        ))}
      </ul>
      {initial.hidden ? <p className="text-danger">Masqués : {initial.hidden.reason}</p> : null}
      {error ? <ErrorBanner title={error} /> : null}
      <Input aria-label="Motif" placeholder={hidden ? "Motif du rétablissement" : "Motif du masquage"} value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
      <Button type="button" variant={hidden ? "outline" : "danger"} size="sm" loading={busy} onClick={() => void act()}>
        {hidden ? "Rétablir les liens" : "Masquer les liens"}
      </Button>
    </div>
  );
}
