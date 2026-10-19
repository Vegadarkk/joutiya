"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { TurnstileWidget, type TurnstileHandle } from "@/components/auth/turnstile-widget";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { InlineError } from "@/components/feedback/inline-error";
import { CityCombobox } from "@/components/post/city-combobox";
import { Textarea } from "@/components/post/controls/textarea";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cityBySlug, type City } from "@/config/regions";
import type { Locale } from "@/config/site";
import { ApiError } from "@/lib/auth/client";
import type { ProApplyInput, ProSelfView } from "@/lib/contracts/pro";
import { LEGAL_FORMS, normalizeIdentifier, type LegalForm } from "@/lib/pro/kybc";
import { submitProApplication } from "@/lib/pro/client";
import { PRO_DESCRIPTION_MAX, PRO_NAME_MAX } from "@/lib/pro/profile-schema";
import { cn } from "@/lib/utils";
import { KybcPieces, type PieceState } from "./kybc-pieces";

// Pro application form (phase 7 design §4): shop, legal form and its identifiers, the number a
// moderator calls while the WhatsApp check is parked, the KYBC pieces, the commitment and a
// Turnstile check. Checked here as the server checks it (src/lib/pro/kybc.ts), so a refusal is
// shown on its field before anything is sent; the server stays the judge.

type Identifier = "ice" | "rc" | "if" | "aeNumber" | "tp";
type FieldKey = "name" | "city" | "form" | Identifier | "phone" | "pieces" | "commitment" | "challenge";

/** Identifier inputs per legal form, in reading order; `commercant` needs rc or tp. */
const IDENTIFIERS: Record<LegalForm, readonly Identifier[]> = {
  societe: ["ice", "rc", "if"],
  auto_entrepreneur: ["ice", "aeNumber"],
  commercant: ["ice", "rc", "tp"],
};

const REGISTRY = /^[A-Z0-9/]{1,30}$/;
/** Moroccan mobile as typed (06…, +212 6…, 00212 6…); the server normalizes and checks it for real. */
const MOBILE = /^(?:0|\+212|00212)[67]\d{8}$/;

export interface Draft {
  name: string;
  description: string;
  city: City | null;
  form: LegalForm | null;
  ids: Record<Identifier, string>;
  phone: string;
  commitment: boolean;
}

type MessageKey = "required" | "nameLength" | "cityRequired" | "iceFormat" | "identifierFormat" | "rcOrTp" | "phoneRequired" | "phoneFormat" | "piecesRequired" | "piecesPending" | "commitmentRequired" | "challenge";

export function initialDraft(previous: ProSelfView | null): Draft {
  const form = previous && (LEGAL_FORMS as readonly string[]).includes(previous.legalForm) ? (previous.legalForm as LegalForm) : null;
  return {
    name: previous?.name ?? "",
    description: previous?.description ?? "",
    city: previous ? (cityBySlug(previous.citySlug) ?? null) : null,
    form,
    // The registry numbers of a rejected application are not sent back (only the ICE is shown).
    ids: { ice: previous?.ice ?? "", rc: "", if: "", aeNumber: "", tp: "" },
    phone: "",
    commitment: false,
  };
}

export function draftProblems(draft: Draft, pieces: readonly PieceState[], needsPhone: boolean, token: string | null): Partial<Record<FieldKey, MessageKey>> {
  const out: Partial<Record<FieldKey, MessageKey>> = {};
  const name = draft.name.trim();
  if (name === "") out.name = "required";
  else if (name.length < 2 || name.length > PRO_NAME_MAX) out.name = "nameLength";
  if (!draft.city) out.city = "cityRequired";
  if (!draft.form) out.form = "required";
  else {
    const ice = normalizeIdentifier(draft.ids.ice);
    if (ice === "") out.ice = "required";
    else if (!/^\d{15}$/.test(ice)) out.ice = "iceFormat";
    for (const key of IDENTIFIERS[draft.form]) {
      if (key === "ice") continue;
      const value = normalizeIdentifier(draft.ids[key]);
      if (value === "") {
        if (draft.form !== "commercant") out[key] = "required";
      } else if (!REGISTRY.test(value)) out[key] = "identifierFormat";
    }
    if (draft.form === "commercant" && normalizeIdentifier(draft.ids.rc) === "" && normalizeIdentifier(draft.ids.tp) === "") out.rc = "rcOrTp";
  }
  if (needsPhone) {
    const phone = draft.phone.replace(/[\s.()-]/g, "");
    if (phone === "") out.phone = "phoneRequired";
    else if (!MOBILE.test(phone)) out.phone = "phoneFormat";
  }
  if (pieces.some((piece) => piece.phase === "uploading")) out.pieces = "piecesPending";
  else if (!pieces.some((piece) => piece.phase === "ready")) out.pieces = "piecesRequired";
  if (!draft.commitment) out.commitment = "commitmentRequired";
  if (!token) out.challenge = "challenge";
  return out;
}

function legalOf(draft: Draft & { form: LegalForm }): ProApplyInput["legal"] {
  const id = (key: Identifier) => normalizeIdentifier(draft.ids[key]);
  if (draft.form === "societe") return { form: "societe", ice: id("ice"), rc: id("rc"), if: id("if") };
  if (draft.form === "auto_entrepreneur") return { form: "auto_entrepreneur", ice: id("ice"), aeNumber: id("aeNumber") };
  return { form: "commercant", ice: id("ice"), ...(id("rc") ? { rc: id("rc") } : {}), ...(id("tp") ? { tp: id("tp") } : {}) };
}

interface ProApplicationFormProps {
  /** The rejected application being corrected, or null for a first application. */
  previous: ProSelfView | null;
  /** The number is asked: not verified on the account and the WhatsApp check is parked. */
  needsPhone: boolean;
  /** Sent, or refused because the account's state changed meanwhile: the area reloads. */
  onDone: () => void;
}

export function ProApplicationForm({ previous, needsPhone, onDone }: ProApplicationFormProps) {
  const t = useTranslations("Pro.form");
  const errors = useTranslations("Pro.errors");
  const apiMessage = useApiErrorMessage();
  const locale = useLocale() as Locale;
  const formRef = useRef<HTMLFormElement>(null);
  const turnstile = useRef<TurnstileHandle>(null);
  const [draft, setDraft] = useState<Draft>(() => initialDraft(previous));
  const [pieces, setPieces] = useState<PieceState[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const problems = attempted ? draftProblems(draft, pieces, needsPhone, token) : {};
  const message = (key: FieldKey) => {
    const found = problems[key];
    return found ? t(found) : undefined;
  };
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const setId = (key: Identifier, value: string) => setDraft((current) => ({ ...current, ids: { ...current.ids, [key]: value } }));

  function failureText(caught: unknown): string {
    const code = caught instanceof ApiError ? caught.code : "internal";
    const key = code as Parameters<typeof errors.has>[0];
    return errors.has(key) ? errors(key) : apiMessage(caught);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setAttempted(true);
    const found = draftProblems(draft, pieces, needsPhone, token);
    if (Object.keys(found).length > 0 || !draft.form || !draft.city || !token) {
      // The first invalid control takes the focus, once the messages are rendered.
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      await submitProApplication({
        name: draft.name.trim(),
        description: draft.description.trim(),
        regionCode: draft.city.regionCode,
        citySlug: draft.city.slug,
        legal: legalOf({ ...draft, form: draft.form }),
        ...(needsPhone ? { phone: draft.phone.trim() } : {}),
        uploadIds: pieces.flatMap((piece) => (piece.phase === "ready" ? [piece.uploadId] : [])),
        complianceCommitment: true,
        turnstileToken: token,
      });
      toast.success(t("submitted"), { description: t("submittedBody") });
      onDone();
    } catch (caught) {
      setPending(false);
      // A token is single use: a fresh one for the next attempt, whatever went wrong.
      setToken(null);
      turnstile.current?.reset();
      if (caught instanceof ApiError && ["already_pro", "pro_application_exists", "pro_signup_closed", "account_suspended", "email_not_verified"].includes(caught.code)) {
        toast.error(failureText(caught));
        onDone();
        return;
      }
      setFailure(caught);
    }
  }

  return (
    <form ref={formRef} onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-10">
      <Section title={t("shopTitle")}>
        <Field label={t("name")} hint={t("nameHint", { max: PRO_NAME_MAX })} error={message("name")} required>
          <Input value={draft.name} maxLength={PRO_NAME_MAX} dir="auto" autoComplete="organization" onChange={(event) => set({ name: event.target.value })} />
        </Field>
        <Field label={t("description")} hint={t("descriptionHint")}>
          <Textarea value={draft.description} rows={3} maxLength={PRO_DESCRIPTION_MAX} dir="auto" className="min-h-24" onChange={(event) => set({ description: event.target.value })} />
        </Field>
        <CityCombobox value={draft.city} onSelect={(city) => set({ city })} error={message("city")} required locale={locale} />
      </Section>

      <Section title={t("legalTitle")}>
        <fieldset className="flex flex-col gap-3" aria-invalid={problems.form ? true : undefined}>
          <legend className="mb-1.5 text-sm font-medium">
            {t("legalForm")}
            <span className="ms-0.5 text-danger" aria-hidden="true">
              *
            </span>
          </legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {LEGAL_FORMS.map((form) => (
              <label
                key={form}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-md border bg-surface p-3.5 transition-colors duration-150",
                  draft.form === form ? "border-structure bg-structure/5 dark:border-gold-300" : "border-border hover:border-border-strong",
                )}
              >
                <input type="radio" name="legal-form" value={form} checked={draft.form === form} onChange={() => set({ form })} className="mt-1 size-4 shrink-0 accent-structure" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{t(`forms.${form}`)}</span>
                  <span className="text-xs text-foreground-muted text-pretty">{t(`legalFormHint.${form}`)}</span>
                </span>
              </label>
            ))}
          </div>
          {problems.form ? <InlineError>{t(problems.form)}</InlineError> : null}
        </fieldset>
        {draft.form ? (
          <div className="grid gap-5 sm:grid-cols-2">
            {IDENTIFIERS[draft.form].map((key) => (
              <Field
                key={key}
                label={t(key)}
                hint={key === "ice" ? t("iceHint") : draft.form === "commercant" && key === "rc" ? t("rcOrTp") : undefined}
                error={message(key)}
                required={draft.form !== "commercant" || key === "ice"}
                className={key === "ice" ? "sm:col-span-2" : undefined}
              >
                <Input
                  value={draft.ids[key]}
                  dir="ltr"
                  inputMode={key === "ice" ? "numeric" : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={key === "ice" ? 24 : 40}
                  className="font-medium tracking-wide tabular-nums"
                  onChange={(event) => setId(key, event.target.value)}
                />
              </Field>
            ))}
          </div>
        ) : null}
      </Section>

      {needsPhone ? (
        <Section title={t("phoneTitle")}>
          <Field label={t("phone")} hint={t("phoneHint")} error={message("phone")} required>
            <Input type="tel" value={draft.phone} dir="ltr" inputMode="tel" autoComplete="tel" maxLength={20} placeholder="06 12 34 56 78" onChange={(event) => set({ phone: event.target.value })} />
          </Field>
        </Section>
      ) : null}

      <Section title={t("piecesTitle")}>
        <KybcPieces pieces={pieces} onChange={setPieces} error={message("pieces")} />
      </Section>

      <Section title={t("commitTitle")}>
        <div className="flex flex-col gap-1.5">
          <label className="flex cursor-pointer items-start gap-3 text-sm text-pretty">
            <input
              type="checkbox"
              checked={draft.commitment}
              aria-invalid={problems.commitment ? true : undefined}
              onChange={(event) => set({ commitment: event.target.checked })}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span>{t("commitment")}</span>
          </label>
          {problems.commitment ? <InlineError>{t(problems.commitment)}</InlineError> : null}
        </div>
        <TurnstileWidget ref={turnstile} action="pro-apply" cData="pro-apply" onToken={setToken} error={message("challenge")} />
      </Section>

      {failure ? <FormMessage error={failure} title={failureText(failure)} /> : null}

      <div className="flex justify-end border-t border-border pt-6">
        <Button type="submit" variant="structure" loading={pending} className="w-full sm:w-auto">
          {previous ? t("resubmit") : t("submit")}
        </Button>
      </div>
    </form>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-5">
      <h2 className="text-lg font-semibold text-balance">{title}</h2>
      {children}
    </section>
  );
}
