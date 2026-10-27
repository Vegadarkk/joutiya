"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { inputClassName } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ADMIN_API, adminFetch, errorMessage } from "./api-client";

const REASON_MIN = 3;
const REASON_MAX = 500;

const MESSAGES: Record<string, string> = {
  conflict: "Ce compte n'a plus de numéro vérifié. Rechargez la page.",
  not_found: "Ce compte n'existe plus. Rechargez la page.",
  rate_limited: "Trop de décisions en peu de temps. Réessayez dans quelques minutes.",
};

interface RevokePhoneButtonProps {
  uid: string;
  name: string;
}

/**
 * Withdraws an account's verified number and its badge (audit C1-02), with a confirmation dialog
 * and a reason kept in the audit log. The member can verify a number again; for a fraud, also
 * decide a sanction.
 */
export function RevokePhoneButton({ uid, name }: RevokePhoneButtonProps) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const problem = reason.trim().length < REASON_MIN ? "Indiquez le motif (3 caractères au moins)." : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched(true);
    if (problem) return;
    setError(null);
    setLoading(true);
    try {
      await adminFetch(`${ADMIN_API.users}/${encodeURIComponent(uid)}/phone`, { method: "DELETE", csrf: true, body: { reason: reason.trim() } });
      dialog.current?.close();
      toast.success(`Badge téléphone retiré à ${name}`, { description: "Le numéro n'est plus affiché ni révélé sur ses annonces." });
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => dialog.current?.showModal()}>
        Retirer le badge
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-border bg-surface p-6 text-foreground shadow-xl backdrop:bg-foreground/40"
      >
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <h2 id={titleId} className="text-lg font-semibold text-balance">
            Retirer le numéro vérifié de {name} ?
          </h2>
          <p className="text-sm text-foreground-muted">
            Le numéro et son badge quittent le compte : ses annonces n&apos;affichent plus de téléphone. La personne peut vérifier un numéro à nouveau. En cas
            d&apos;escroquerie, décidez aussi une sanction.
          </p>
          <Field label="Motif" required error={touched ? problem : undefined} hint="Gardé dans le journal d'audit, jamais envoyé au membre.">
            <textarea
              name="reason"
              rows={3}
              maxLength={REASON_MAX}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              onBlur={() => setTouched(true)}
              className={cn(inputClassName, "h-auto min-h-20 py-2")}
            />
          </Field>
          {error ? <ErrorBanner title={error} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => dialog.current?.close()} disabled={loading}>
              Annuler
            </Button>
            <Button type="submit" variant="danger" size="sm" loading={loading}>
              Retirer le badge
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
