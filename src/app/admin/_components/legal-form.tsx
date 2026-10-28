"use client";

import { useRouter } from "next/navigation";
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { InlineError } from "@/components/feedback/inline-error";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, inputClassName } from "@/components/ui/input";
import { LEGAL_FORMS, type LegalConfig } from "@/config/legal";
import type { LegalAdminView } from "@/lib/legal/admin";
import { ADMIN_API, ApiError, adminFetch, errorMessage } from "./api-client";

const MESSAGES: Record<string, string> = {
  invalid_body: "Certains champs sont invalides : corrigez les champs signalés.",
  legal_incomplete: "Des mentions obligatoires (art. 1-1 LCEN) manquent : la production refuserait de démarrer.",
  conflict: "Un autre admin a modifié ces mentions entre-temps. Rechargez la page, puis refaites vos changements.",
  forbidden: "Réservé aux admins.",
};

const LANGUAGES = [
  { value: "fr", label: "Français" },
  { value: "ar", label: "Arabe" },
  { value: "en", label: "Anglais" },
] as const;

type DataHost = LegalConfig["dataHosts"][number];
const EMPTY_HOST: DataHost = { name: "", region: "", address: "", phone: "" };

/** Field errors from the API: invalid paths of the body, then the missing mentions. */
function fieldErrors(cause: unknown): Record<string, string> {
  if (!(cause instanceof ApiError)) return {};
  const errors: Record<string, string> = {};
  if (cause.code === "invalid_body" && Array.isArray(cause.details)) {
    for (const issue of cause.details as { path?: string }[]) {
      if (issue.path?.startsWith("config.")) errors[issue.path.slice("config.".length)] = "Valeur invalide.";
    }
  }
  if (cause.code === "legal_incomplete") {
    for (const path of (cause.details as { missing?: string[] } | undefined)?.missing ?? []) errors[path.replace(/\[(\d+)\]/g, ".$1")] = "Mention obligatoire.";
  }
  return errors;
}

function Section({ title, description, grid = true, children }: { title: string; description?: ReactNode; grid?: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <div>
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {description ? <p className="mt-1 max-w-prose text-sm text-foreground-muted">{description}</p> : null}
      </div>
      {grid ? <div className="grid gap-4 sm:grid-cols-2">{children}</div> : children}
    </section>
  );
}

/** A number input's value: empty while the field is cleared. */
const numberValue = (value: number) => (Number.isNaN(value) ? "" : value);

/** Edition of `config/legal`: every field of the schema, saved at once and journaled. */
export function LegalForm({ initial }: { initial: LegalAdminView }) {
  const router = useRouter();
  const [config, setConfig] = useState<LegalConfig>(initial.config);
  const [saved, setSaved] = useState<LegalConfig>(initial.config);
  const [version, setVersion] = useState(initial.version);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const dirty = useMemo(() => JSON.stringify(config) !== JSON.stringify(saved), [config, saved]);
  const company = config.legalForm !== "EI";
  // An invalid stored document (rendered as the defaults) can be replaced without editing a field.
  const [replaceInvalid, setReplaceInvalid] = useState(initial.errors.length > 0);

  const set = <K extends keyof LegalConfig>(key: K, value: LegalConfig[K]) => setConfig((current) => ({ ...current, [key]: value }));
  const setHost = (key: keyof LegalConfig["host"], value: string) => setConfig((current) => ({ ...current, host: { ...current.host, [key]: value } }));
  const setDataHost = (index: number, key: keyof DataHost, value: string) =>
    setConfig((current) => ({ ...current, dataHosts: current.dataHosts.map((host, at) => (at === index ? { ...host, [key]: value } : host)) }));

  /** A text input bound to a top-level string field. */
  const text = (key: keyof LegalConfig, label: string, options: { hint?: ReactNode; type?: string; required?: boolean; inputMode?: "numeric" | "email" | "tel" | "url" } = {}) => (
    <Field label={label} hint={options.hint} error={errors[key]} required={options.required}>
      <Input
        name={key}
        type={options.type ?? "text"}
        inputMode={options.inputMode}
        autoComplete="off"
        value={String(config[key] ?? "")}
        onChange={(event) => set(key, event.target.value as never)}
      />
    </Field>
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setErrors({});
    setLoading(true);
    try {
      const view = await adminFetch<LegalAdminView>(ADMIN_API.legal, { method: "PUT", csrf: true, body: { config, version } });
      if (view) {
        setConfig(view.config);
        setSaved(view.config);
        setVersion(view.version);
        setReplaceInvalid(view.errors.length > 0);
      }
      toast.success("Mentions légales enregistrées.");
      router.refresh();
    } catch (cause) {
      setErrors(fieldErrors(cause));
      setError(errorMessage(cause, MESSAGES));
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <Section title="Éditeur" description="Identité de l'éditeur, telle qu'elle figure au registre. La forme juridique change le rendu des mentions.">
        <Field label="Forme juridique" required>
          <select name="legalForm" value={config.legalForm} onChange={(event) => set("legalForm", event.target.value as LegalConfig["legalForm"])} className={inputClassName}>
            {LEGAL_FORMS.map((form) => (
              <option key={form} value={form}>
                {form === "EI" ? "EI (entrepreneur individuel)" : form}
              </option>
            ))}
          </select>
        </Field>
        {text("companyName", company ? "Dénomination sociale" : "Nom commercial", { required: true })}
        {company
          ? text("shareCapital", "Capital social (€)", { required: true, inputMode: "numeric" })
          : text("entrepreneurName", "Nom de l'entrepreneur", { required: true, hint: "Exactement comme au registre (RNE)." })}
        {text("hqAddress", "Adresse du siège", { required: true, hint: "Seule adresse affichée : la domiciliation. Jamais une adresse personnelle." })}
        {text("siren", "SIREN", { required: true, inputMode: "numeric", hint: "9 chiffres." })}
        {text("siret", "SIRET", { inputMode: "numeric", hint: "14 chiffres, ou vide." })}
        <Field label="Registre" required>
          <select name="registry" value={config.registry} onChange={(event) => set("registry", event.target.value as LegalConfig["registry"])} className={inputClassName}>
            <option value="RNE">RNE</option>
            <option value="RCS">RCS</option>
          </select>
        </Field>
        {text("rcsCity", "Ville du RCS", { hint: "Obligatoire pour une société ou une inscription au RCS." })}
        <Field label="Régime de TVA" required>
          <select name="vatRegime" value={config.vatRegime} onChange={(event) => set("vatRegime", event.target.value as LegalConfig["vatRegime"])} className={inputClassName}>
            <option value="franchise">Franchise en base (art. 293 B du CGI)</option>
            <option value="assujetti">Assujetti</option>
          </select>
        </Field>
        {text("vatNumber", "Numéro de TVA intracommunautaire", { hint: "FR + 11 caractères. Obligatoire si assujetti." })}
        {text("phone", "Téléphone de l'éditeur", { required: true, type: "tel", inputMode: "tel" })}
        {text("email", "E-mail de contact", { required: true, type: "email", inputMode: "email" })}
        {text("publicationDirector", "Directeur de la publication", { required: true })}
      </Section>

      <Section title="Contacts et conformité">
        {text("dsaContactEmail", "Point de contact DSA", { required: true, type: "email", inputMode: "email" })}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium text-foreground">
            Langues du point de contact DSA
            <span className="ms-0.5 text-danger" aria-hidden="true">
              *
            </span>
          </legend>
          <div className="flex min-h-11 flex-wrap items-center gap-x-5 gap-y-2">
            {LANGUAGES.map(({ value, label }) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={config.dsaContactLanguages.includes(value)}
                  onChange={(event) =>
                    set(
                      "dsaContactLanguages",
                      event.target.checked ? LANGUAGES.map((item) => item.value).filter((item) => item === value || config.dsaContactLanguages.includes(item)) : config.dsaContactLanguages.filter((item) => item !== value),
                    )
                  }
                />
                {label}
              </label>
            ))}
          </div>
          {errors["dsaContactLanguages"] ? <InlineError>Choisissez au moins une langue.</InlineError> : null}
        </fieldset>
        {text("abuseEmail", "E-mail des signalements", { required: true, type: "email", inputMode: "email" })}
        {text("dpoContact", "Contact données personnelles")}
        {text("cndpReceiptNo", "Récépissé CNDP", { hint: "La phrase CNDP n'apparaît qu'une fois ce numéro renseigné." })}
        <Field label="Médiateur de la consommation" error={errors["consumerMediator.name"]} hint="Requis avant l'ouverture des ventes.">
          <Input name="consumerMediator.name" autoComplete="off" value={config.consumerMediator.name} onChange={(event) => set("consumerMediator", { ...config.consumerMediator, name: event.target.value })} />
        </Field>
        <Field label="Site du médiateur" error={errors["consumerMediator.url"]}>
          <Input name="consumerMediator.url" type="url" inputMode="url" autoComplete="off" value={config.consumerMediator.url} onChange={(event) => set("consumerMediator", { ...config.consumerMediator, url: event.target.value })} />
        </Field>
      </Section>

      <Section title="Hébergeur du site">
        <Field label="Nom" error={errors["host.name"]} required>
          <Input name="host.name" autoComplete="off" value={config.host.name} onChange={(event) => setHost("name", event.target.value)} />
        </Field>
        <Field label="Téléphone" error={errors["host.phone"]} required>
          <Input name="host.phone" type="tel" inputMode="tel" autoComplete="off" value={config.host.phone} onChange={(event) => setHost("phone", event.target.value)} />
        </Field>
        <Field label="Adresse" error={errors["host.address"]} required className="sm:col-span-2">
          <Input name="host.address" autoComplete="off" value={config.host.address} onChange={(event) => setHost("address", event.target.value)} />
        </Field>
      </Section>

      <Section title="Hébergeurs des données" description="Chaque prestataire qui stocke des données du site, avec sa région." grid={false}>
        {config.dataHosts.map((host, index) => (
          <div key={index} className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
            <Field label={`Nom (hébergeur ${index + 1})`} error={errors[`dataHosts.${index}.name`]} required>
              <Input autoComplete="off" value={host.name} onChange={(event) => setDataHost(index, "name", event.target.value)} />
            </Field>
            <Field label="Région" error={errors[`dataHosts.${index}.region`]}>
              <Input autoComplete="off" value={host.region} onChange={(event) => setDataHost(index, "region", event.target.value)} />
            </Field>
            <Field label="Adresse" error={errors[`dataHosts.${index}.address`]} required>
              <Input autoComplete="off" value={host.address} onChange={(event) => setDataHost(index, "address", event.target.value)} />
            </Field>
            <Field label="Téléphone" error={errors[`dataHosts.${index}.phone`]} required>
              <Input type="tel" inputMode="tel" autoComplete="off" value={host.phone} onChange={(event) => setDataHost(index, "phone", event.target.value)} />
            </Field>
            <div className="sm:col-span-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => {
                  set("dataHosts", config.dataHosts.filter((_, at) => at !== index));
                  // Errors are keyed by index: they would land on the next host.
                  setErrors({});
                }}>
                <Trash2 aria-hidden="true" />
                Retirer {host.name ? `« ${host.name} »` : `l'hébergeur ${index + 1}`}
              </Button>
            </div>
          </div>
        ))}
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => set("dataHosts", [...config.dataHosts, EMPTY_HOST])}>
            <Plus aria-hidden="true" />
            Ajouter un hébergeur
          </Button>
        </div>
      </Section>

      <Section title="Durées des annonces" description="Reprises dans les CGU et la politique de confidentialité.">
        <Field label="Durée de publication (jours)" error={errors["listingTtlDays"]} hint="De 1 à 365." required>
          <Input name="listingTtlDays" type="number" inputMode="numeric" min={1} max={365} value={numberValue(config.listingTtlDays)} onChange={(event) => set("listingTtlDays", event.target.valueAsNumber)} />
        </Field>
        <Field label="Suppression après expiration (mois)" error={errors["listingPurgeMonths"]} hint="De 1 à 36." required>
          <Input name="listingPurgeMonths" type="number" inputMode="numeric" min={1} max={36} value={numberValue(config.listingPurgeMonths)} onChange={(event) => set("listingPurgeMonths", event.target.valueAsNumber)} />
        </Field>
      </Section>

      {error ? <ErrorBanner title={error} /> : null}
      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 border-t border-border bg-background/95 px-1 py-3 backdrop-blur">
        <Button type="submit" loading={loading} disabled={!dirty && !replaceInvalid}>
          Enregistrer
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!dirty || loading}
          onClick={() => {
            setConfig(saved);
            setErrors({});
            setError(null);
          }}
        >
          Annuler les changements
        </Button>
        <p className="text-sm text-foreground-muted" aria-live="polite">
          {dirty ? "Changements non enregistrés." : "Aucun changement."}
        </p>
      </div>
    </form>
  );
}
