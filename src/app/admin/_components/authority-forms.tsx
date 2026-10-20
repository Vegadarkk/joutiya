"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { inputClassName } from "@/components/ui/input";
import { REPORT_REASONS } from "@/config/report-reasons";
import {
  AUTHORITY_COUNTRIES,
  AUTHORITY_KINDS,
  createAuthorityRequestSchema,
  updateAuthorityRequestSchema,
  type AuthorityRequestView,
  type CreateAuthorityResponse,
} from "@/lib/decisions/contracts";
import { cn } from "@/lib/utils";
import { COUNTRY_LABEL, KIND_LABEL } from "../_lib/moderation-format";
import { ADMIN_API, adminFetch, errorMessage } from "./api-client";

// Authority requests register (design D17, admin only): record a request (holds, freezes, and for
// a removal order the decisions executing it), then answer or close it.

const MESSAGES: Record<string, string> = {
  invalid_body: "Demande refusée : vérifiez les champs signalés.",
  conflict: "Cette demande est déjà close.",
  forbidden: "Réservé aux admins.",
};

const FIELD_MESSAGES: Record<string, string> = {
  authority: "Nom de l'autorité : 2 à 200 caractères.",
  legalBasis: "Fondement juridique : 2 à 500 caractères.",
  scope: "Une cible par ligne : listing:{id}, user:{uid} ou conversation:{cid}, sans doublon (50 au plus).",
  identityCheck: "Indiquez comment l'identité du demandeur a été vérifiée.",
  receivedAt: "Date de réception requise.",
  dueAt: "Échéance invalide.",
  reasonId: "Une injonction de retrait demande un motif ; les autres demandes n'en ont pas.",
};

/** A datetime-local value (the browser's time) as an ISO instant, or undefined when empty or invalid. */
export function localToIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const textarea = cn(inputClassName, "h-auto min-h-20 py-2");

export function AuthorityCreateForm() {
  const router = useRouter();
  const [values, setValues] = useState({ authority: "", country: "MA", legalBasis: "", kind: "removal_order", scope: "", method: "", receivedAt: "", dueAt: "", reasonId: "", notify: true });
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (key: keyof typeof values) => (event: { target: { value: string } }) => setValues((current) => ({ ...current, [key]: event.target.value }));
  const removal = values.kind === "removal_order";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const dueAt = localToIso(values.dueAt);
    const body = {
      authority: values.authority.trim(),
      country: values.country,
      legalBasis: values.legalBasis.trim(),
      kind: values.kind,
      scope: values.scope
        .split(/\s+/)
        .map((line) => line.trim())
        .filter(Boolean),
      identityCheck: { method: values.method.trim() },
      receivedAt: localToIso(values.receivedAt) ?? "",
      ...(dueAt ? { dueAt } : {}),
      ...(removal && values.reasonId ? { reasonId: values.reasonId } : {}),
      ...(removal && !values.notify ? { notifyAffected: false } : {}),
    };
    const parsed = createAuthorityRequestSchema.safeParse(body);
    if (!parsed.success) {
      const found: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        found[key] ??= FIELD_MESSAGES[key] ?? "Valeur invalide.";
      }
      setProblems(found);
      return;
    }
    setProblems({});
    setLoading(true);
    try {
      const result = await adminFetch<CreateAuthorityResponse>(ADMIN_API.authorities, { method: "POST", csrf: true, body: parsed.data });
      if (!result) throw new Error("empty");
      const notes = [result.decisionIds.length > 0 ? `${result.decisionIds.length} retrait(s) exécuté(s)` : null, result.missing.length > 0 ? `introuvable(s) : ${result.missing.join(", ")}` : null].filter(Boolean);
      toast.success("Demande enregistrée", { description: notes.length > 0 ? `${notes.join(" ; ")}.` : "Contenus visés conservés." });
      router.push(`/autorites/${result.request.id}`);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Autorité" required error={problems["authority"]} hint="Ex. : Parquet de Casablanca, OCLCTIC.">
          <input name="authority" value={values.authority} onChange={set("authority")} maxLength={200} className={inputClassName} />
        </Field>
        <Field label="Pays" required>
          <select name="country" value={values.country} onChange={set("country")} className={inputClassName}>
            {AUTHORITY_COUNTRIES.map((country) => (
              <option key={country} value={country}>
                {COUNTRY_LABEL[country]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Nature" required>
          <select name="kind" value={values.kind} onChange={set("kind")} className={inputClassName}>
            {AUTHORITY_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Fondement juridique" required error={problems["legalBasis"]}>
          <input name="legalBasis" value={values.legalBasis} onChange={set("legalBasis")} maxLength={500} className={inputClassName} />
        </Field>
        <Field label="Reçue le" required error={problems["receivedAt"]} hint="Heure de votre navigateur.">
          <input type="datetime-local" name="receivedAt" value={values.receivedAt} onChange={set("receivedAt")} className={inputClassName} />
        </Field>
        <Field label="Échéance" error={problems["dueAt"]} hint="Une injonction terroriste (TCO) se traite dans l'heure.">
          <input type="datetime-local" name="dueAt" value={values.dueAt} onChange={set("dueAt")} className={inputClassName} />
        </Field>
      </div>
      <Field label="Contenus visés" required error={problems["scope"]} hint="Une cible par ligne : listing:{id}, user:{uid} ou conversation:{cid}. Chacun est conservé ; les conversations sont gelées.">
        <textarea name="scope" rows={3} value={values.scope} onChange={set("scope")} className={textarea} />
      </Field>
      <Field label="Vérification de l'identité du demandeur" required error={problems["identityCheck"]} hint="Rappel au numéro officiel, courriel signé, portail officiel…">
        <input name="method" value={values.method} onChange={set("method")} maxLength={300} className={inputClassName} />
      </Field>
      {removal ? (
        <>
          <Field label="Motif du retrait" required error={problems["reasonId"]} hint="Fixe la priorité du signalement créé (P0 pour une injonction terroriste).">
            <select name="reasonId" value={values.reasonId} onChange={set("reasonId")} className={inputClassName}>
              <option value="">Choisir un motif</option>
              {REPORT_REASONS.map((reason) => (
                <option key={reason.id} value={reason.id}>
                  {reason.priority} {reason.label.fr}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input type="checkbox" checked={values.notify} onChange={(event) => setValues((current) => ({ ...current, notify: event.target.checked }))} className="mt-0.5 size-4 accent-current" />
            <span>
              Informer la personne concernée
              <span className="block text-foreground-muted">Décochez si l&apos;injonction interdit de l&apos;informer : aucun exposé des motifs ne part.</span>
            </span>
          </label>
        </>
      ) : null}
      {error ? <ErrorBanner title={error} /> : null}
      <Button type="submit" variant={removal ? "danger" : "structure"} loading={loading} className="self-start">
        {removal ? "Enregistrer et exécuter le retrait" : "Enregistrer la demande"}
      </Button>
    </form>
  );
}

export function AuthorityUpdateForm({ request }: { request: Pick<AuthorityRequestView, "id" | "status" | "response"> }) {
  const router = useRouter();
  const [status, setStatus] = useState<"answered" | "closed">(request.status === "open" ? "answered" : "closed");
  const [response, setResponse] = useState(request.response ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const text = response.trim();
    const parsed = updateAuthorityRequestSchema.safeParse(text ? { status, response: text } : { status });
    if (!parsed.success) {
      setProblem("La réponse fait 2 à 4 000 caractères ; elle est requise pour marquer la demande comme répondue.");
      return;
    }
    setProblem(null);
    setLoading(true);
    try {
      await adminFetch<{ request: AuthorityRequestView }>(`${ADMIN_API.authorities}/${encodeURIComponent(request.id)}`, { method: "PATCH", csrf: true, body: parsed.data });
      toast.success(status === "answered" ? "Réponse enregistrée" : "Demande close", { description: status === "closed" ? "Conservations levées, conversations dégelées." : undefined });
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, MESSAGES));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <h2 className="text-lg font-semibold">Suite donnée</h2>
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">État</legend>
        {request.status === "open" ? (
          <label className="flex cursor-pointer items-center gap-2.5 text-sm">
            <input type="radio" name="status" checked={status === "answered"} onChange={() => setStatus("answered")} className="size-4 accent-current" />
            Répondue (les conservations restent)
          </label>
        ) : null}
        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
          <input type="radio" name="status" checked={status === "closed"} onChange={() => setStatus("closed")} className="size-4 accent-current" />
          Close (conservations levées, conversations dégelées)
        </label>
      </fieldset>
      <Field label="Réponse" required={status === "answered"} error={problem}>
        <textarea name="response" rows={4} maxLength={4000} value={response} onChange={(event) => setResponse(event.target.value)} className={textarea} />
      </Field>
      {error ? <ErrorBanner title={error} /> : null}
      <Button type="submit" variant="structure" loading={loading} className="self-start">
        {status === "answered" ? "Enregistrer la réponse" : "Clore la demande"}
      </Button>
    </form>
  );
}
