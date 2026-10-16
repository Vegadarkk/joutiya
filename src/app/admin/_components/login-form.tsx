"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { StaffLoginResponse } from "@/lib/auth/staff";
import { ADMIN_API, adminFetch, errorMessage } from "./api-client";
import { SetPasswordForm } from "./set-password-form";
import { Turnstile } from "./turnstile";

// Staff sign-in. Cloudflare Access has already identified the person (e-mail prefilled, read-only);
// the password is the second check. From the 3rd failure the API asks for Turnstile: the widget
// appears and the attempt is resent as soon as it is solved.

const MESSAGES: Record<string, string> = {
  invalid_credentials: "E-mail ou mot de passe incorrect.",
  account_locked: "Trop de tentatives. Réessayez dans 15 minutes.",
  account_disabled: "Ce compte est désactivé. Demandez une nouvelle invitation à un admin.",
  forbidden: "Ce compte n'a pas accès au back-office, ou son e-mail diffère de votre identité Cloudflare Access.",
  unauthenticated: "Identité Cloudflare Access absente. Rechargez la page pour vous reconnecter.",
  turnstile_failed: "La vérification anti-robot a échoué. Réessayez.",
  invalid_body: "Vérifiez l'e-mail et le mot de passe.",
};

interface LoginFormProps {
  /** E-mail asserted by Cloudflare Access; null only in development without Access. */
  accessEmail: string | null;
  nonce?: string;
  turnstileSiteKey: string | null;
  /** `?mode=setPassword&oobCode=`: the set-password form comes first, then the sign-in form. */
  setPasswordCode: string | null;
}

export function LoginForm({ accessEmail, nonce, turnstileSiteKey, setPasswordCode }: LoginFormProps) {
  const router = useRouter();
  const [stage, setStage] = useState<"password" | "login">(setPasswordCode ? "password" : "login");
  if (stage === "password" && setPasswordCode) {
    return (
      <SetPasswordForm
        oobCode={setPasswordCode}
        onDone={() => {
          setStage("login");
          router.replace("/connexion");
        }}
      />
    );
  }
  return <SignInForm accessEmail={accessEmail} nonce={nonce} turnstileSiteKey={turnstileSiteKey} />;
}

function SignInForm({ accessEmail, nonce, turnstileSiteKey }: Omit<LoginFormProps, "setPasswordCode">) {
  const router = useRouter();
  const [email, setEmail] = useState(accessEmail ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [challenge, setChallenge] = useState(false);
  // Turnstile tokens are single-use: a failed attempt remounts the widget.
  const [attempt, setAttempt] = useState(0);

  async function submit(turnstileToken?: string) {
    setLoading(true);
    setError(null);
    try {
      let token = turnstileToken;
      for (;;) {
        const result = await adminFetch<StaffLoginResponse>(ADMIN_API.login, {
          method: "POST",
          body: { email, password, ...(token ? { turnstileToken: token } : {}) },
        });
        if (result?.status === "turnstile_required") {
          // Development without Turnstile keys: the server accepts any token (dev bypass).
          if (!turnstileSiteKey && !token) {
            token = "dev-bypass";
            continue;
          }
          setChallenge(true);
          return;
        }
        if (result?.status === "signed_in") {
          router.push("/");
          router.refresh();
          return;
        }
        setError(errorMessage(null, MESSAGES));
        return;
      }
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
      setAttempt((value) => value + 1);
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password) return setError("Saisissez votre mot de passe.");
    if (challenge && turnstileSiteKey) return setError("Validez la vérification anti-robot ci-dessous.");
    void submit();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold">Connexion</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Back-office Joutiya. Votre identité Cloudflare Access est vérifiée ; saisissez le mot de passe de votre compte du personnel.
        </p>
      </div>
      <Field label="E-mail" hint={accessEmail ? "Fourni par Cloudflare Access." : undefined} required>
        <Input
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          value={email}
          readOnly={accessEmail !== null}
          aria-readonly={accessEmail !== null || undefined}
          onChange={(event) => setEmail(event.target.value)}
          className={accessEmail ? "bg-surface-muted text-foreground-muted" : undefined}
        />
      </Field>
      <Field label="Mot de passe" required>
        <Input
          type="password"
          name="password"
          autoComplete="current-password"
          maxLength={128}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoFocus
        />
      </Field>
      {challenge && turnstileSiteKey ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-foreground-muted">Plusieurs tentatives ont échoué : une vérification anti-robot est demandée.</p>
          <Turnstile key={attempt} siteKey={turnstileSiteKey} action="staff-login" nonce={nonce} onToken={(token) => void submit(token)} />
        </div>
      ) : null}
      {error ? <ErrorBanner title={error} /> : null}
      <Button type="submit" loading={loading} className="w-full">
        Se connecter
      </Button>
      <p className="text-xs text-foreground-muted">
        Mot de passe oublié ou premier accès : un admin vous envoie un lien pour le définir. Les sessions durent 8 heures.
      </p>
    </form>
  );
}
