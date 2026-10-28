"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ADMIN_API, adminFetch, errorMessage } from "./api-client";

const MESSAGES: Record<string, string> = {
  not_found: "Ce lien n'a pas encore été contrôlé, ou son adresse a changé : attendez le prochain contrôle.",
  rate_limited: "Trop de validations en peu de temps. Réessayez dans quelques minutes.",
};

/**
 * "Marquer comme vérifié" on a guide link (guide-demarches G4): the staff member read the official
 * page and found the guide still right; its current version becomes the reference.
 */
export function GuideLinkAccept({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function accept() {
    setLoading(true);
    try {
      await adminFetch(`${ADMIN_API.guideLinks}/${encodeURIComponent(id)}/accept`, { method: "POST", csrf: true });
      toast.success("Lien marqué comme vérifié", { description: label });
      router.refresh();
    } catch (cause) {
      toast.error("Validation impossible", { description: errorMessage(cause, MESSAGES) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={accept} disabled={loading} aria-label={`Marquer comme vérifié : ${label}`}>
      {loading ? "Validation…" : "Marquer comme vérifié"}
    </Button>
  );
}
