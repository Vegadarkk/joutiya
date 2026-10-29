"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, inputClassName } from "@/components/ui/input";
import type { StaffInviteResponse } from "@/lib/auth/staff";
import type { StaffRole } from "@/lib/db/repositories/staff";
import { ADMIN_API, adminFetch, errorMessage } from "./api-client";

const MESSAGES: Record<string, string> = {
  conflict:
    "Impossible : cet e-mail est le vôtre, ou un compte Aalan existe déjà avec cette adresse (acheteur, vendeur ou inscription jamais confirmée). Les comptes du personnel sont séparés : utilisez une autre adresse.",
  invalid_body: "Vérifiez le nom (2 à 40 caractères), l'e-mail et le rôle.",
  forbidden: "Réservé aux admins.",
};

/** Invitation of a moderator or admin: the account receives a link to set its password. */
export function InviteForm() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRole>("moderator");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await adminFetch<StaffInviteResponse>(ADMIN_API.staff, { method: "POST", csrf: true, body: { email, displayName, role } });
      toast.success(`Invitation envoyée à ${email.trim().toLowerCase()}`);
      setDisplayName("");
      setEmail("");
      setRole("moderator");
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <div>
        <h2 className="text-lg font-semibold">Inviter un membre</h2>
        <p className="mt-1 text-sm text-foreground-muted">
          La personne reçoit un lien pour définir son mot de passe. Son compte Google doit avoir la validation en deux étapes et être autorisé dans
          Cloudflare Access.
        </p>
      </div>
      <Field label="Nom" required>
        <Input name="displayName" autoComplete="off" minLength={2} maxLength={40} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      </Field>
      <Field label="E-mail" required>
        <Input type="email" name="email" autoComplete="off" inputMode="email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </Field>
      <Field label="Rôle" hint={role === "admin" ? "Gère les rôles, la configuration et le journal d'audit." : "Traite les signalements et les vérifications Pro."}>
        <select name="role" value={role} onChange={(event) => setRole(event.target.value as StaffRole)} className={inputClassName}>
          <option value="moderator">Modérateur</option>
          <option value="admin">Admin</option>
        </select>
      </Field>
      {error ? <ErrorBanner title={error} /> : null}
      <Button type="submit" loading={loading}>
        Envoyer l&apos;invitation
      </Button>
    </form>
  );
}
