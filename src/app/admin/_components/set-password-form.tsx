"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { StaffPasswordResponse } from "@/lib/auth/staff";
import { ADMIN_API, adminFetch, errorMessage } from "./api-client";

// First password of an invited member (link mailed by an admin or printed by create-admin.ts),
// or a later reset. The code's e-mail must be the Cloudflare Access identity of this browser.

const MESSAGES: Record<string, string> = {
  invalid_code: "Ce lien d'invitation n'est plus valable. Demandez une nouvelle invitation à un admin.",
  expired_code: "Ce lien a expiré. Demandez une nouvelle invitation à un admin.",
  weak_password: "Mot de passe trop faible : 8 caractères au minimum.",
  forbidden: "Ce lien ne correspond pas à votre identité Cloudflare Access, ou le compte n'est pas membre du personnel.",
  account_disabled: "Ce compte est désactivé. Demandez une nouvelle invitation à un admin.",
  unauthenticated: "Identité Cloudflare Access absente. Rechargez la page.",
  invalid_body: "Vérifiez le mot de passe (8 à 128 caractères).",
};

export function SetPasswordForm({ oobCode, onDone }: { oobCode: string; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) return setError("8 caractères au minimum.");
    if (password !== confirmation) return setError("Les deux mots de passe diffèrent.");
    setError(null);
    setLoading(true);
    try {
      await adminFetch<StaffPasswordResponse>(ADMIN_API.password, { method: "POST", body: { oobCode, password } });
      toast.success("Mot de passe enregistré. Connectez-vous.");
      onDone();
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold">Définir mon mot de passe</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Choisissez le mot de passe de votre compte du back-office. Vous vous connecterez ensuite avec lui, derrière Cloudflare Access.
        </p>
      </div>
      <Field label="Nouveau mot de passe" hint="8 caractères au minimum" required>
        <Input
          type="password"
          name="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoFocus
        />
      </Field>
      <Field label="Confirmation" required>
        <Input
          type="password"
          name="confirmation"
          autoComplete="new-password"
          maxLength={128}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </Field>
      {error ? <ErrorBanner title={error} /> : null}
      <Button type="submit" loading={loading} className="w-full">
        Enregistrer le mot de passe
      </Button>
    </form>
  );
}
