"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ResendNoticeResponse } from "@/lib/decisions/contracts";
import { ADMIN_API, adminFetch, errorMessage } from "./api-client";

const MESSAGES: Record<string, string> = {
  conflict: "Pas d'exposé des motifs à renvoyer : rétablissement, décision annulée sur recours, ou injonction qui interdit d'informer.",
  rate_limited: "Trop d'envois en peu de temps. Réessayez dans quelques minutes.",
};

/** The statement of reasons sent again (D13, audit D1a-08), e.g. after a degraded mail quota skipped it. */
export function ResendNoticeButton({ decisionId }: { decisionId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  async function resend() {
    setLoading(true);
    try {
      const result = await adminFetch<ResendNoticeResponse>(`${ADMIN_API.decisions}/${encodeURIComponent(decisionId)}/notify`, { method: "POST", csrf: true });
      if (result?.sent) toast.success("Exposé des motifs renvoyé", { description: "Il part dans la file d'envoi des e-mails." });
      else toast.warning("Aucun destinataire", { description: "Le compte est clos ou supprimé : rien n'a été envoyé." });
      router.refresh();
    } catch (cause) {
      toast.error(errorMessage(cause, MESSAGES));
    } finally {
      setLoading(false);
    }
  }
  return (
    <Button type="button" variant="outline" size="sm" loading={loading} onClick={resend}>
      Renvoyer l&apos;exposé des motifs
    </Button>
  );
}
