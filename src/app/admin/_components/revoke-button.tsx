"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { ADMIN_API, adminFetch, errorMessage } from "./api-client";

const MESSAGES: Record<string, string> = {
  forbidden: "Vous ne pouvez pas révoquer votre propre accès.",
  not_found: "Ce membre n'existe plus. Rechargez la page.",
};

interface RevokeButtonProps {
  uid: string;
  name: string;
}

/** Revocation with a confirmation dialog: the account is disabled and every session closed. */
export function RevokeButton({ uid, name }: RevokeButtonProps) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function confirm() {
    setError(null);
    setLoading(true);
    try {
      await adminFetch(`${ADMIN_API.staff}/${encodeURIComponent(uid)}`, { method: "DELETE", csrf: true });
      dialog.current?.close();
      toast.success(`Accès de ${name} révoqué`);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => dialog.current?.showModal()}>
        Révoquer
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-lg border border-border bg-surface p-6 text-foreground shadow-xl backdrop:bg-foreground/40"
      >
        <h2 id={titleId} className="text-lg font-semibold text-balance">
          Révoquer l&apos;accès de {name} ?
        </h2>
        <p className="mt-2 text-sm text-foreground-muted">
          Son compte est désactivé et ses sessions sont fermées immédiatement. Une nouvelle invitation le réactive.
        </p>
        {error ? <ErrorBanner title={error} className="mt-4" /> : null}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => dialog.current?.close()} disabled={loading}>
            Annuler
          </Button>
          <Button type="button" variant="danger" size="sm" loading={loading} onClick={confirm}>
            Révoquer l&apos;accès
          </Button>
        </div>
      </dialog>
    </>
  );
}
