"use client";

import { useId, useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import { Flag } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseReportReference, type ReportReference } from "@/lib/reports/reference";
import { cn } from "@/lib/utils";
import { loadReportDialog } from "./report-button";

// "Signaler un contenu illicite" on the contact page (DSA art. 16(1), Phase 6 legal review of
// 29 Oct 2026): a content met through a shared link, or gone from view, has no "Signaler" button in
// front of the person. The address or the listing's reference names the target and the usual
// notice form opens (reason, explanation, a visitor's name and e-mail, the good-faith statement),
// loaded on demand like the report buttons' one.

const ReportDialog = dynamic(() => loadReportDialog(), { ssr: false });

export function ReportReferenceForm({ email, className }: { email: string; className?: string }) {
  const t = useTranslations("Contact.report");
  const id = useId();
  const [value, setValue] = useState("");
  const [reference, setReference] = useState<ReportReference | null>(null);
  const [address, setAddress] = useState("");
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseReportReference(value);
    if (!parsed) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setReference(parsed);
    setAddress(value.trim());
    setOpen(true);
  }

  return (
    <form onSubmit={submit} noValidate className={cn("flex flex-col gap-3", className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {t("label")}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={id}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (invalid) setInvalid(false);
          }}
          placeholder={t("placeholder")}
          aria-describedby={invalid ? `${id}-error` : `${id}-hint`}
          aria-invalid={invalid || undefined}
          className="h-12 sm:flex-1"
        />
        <Button type="submit" className="h-12 sm:shrink-0">
          <Flag aria-hidden="true" />
          {t("submit")}
        </Button>
      </div>
      {invalid ? (
        <p id={`${id}-error`} role="alert" className="text-sm text-danger text-pretty">
          {t("invalid")}
        </p>
      ) : (
        <p id={`${id}-hint`} className="text-xs text-foreground-muted text-pretty">
          {t("hint")}
        </p>
      )}
      {reference ? (
        <ReportDialog
          key={`${reference.type}:${reference.id}`}
          open={open}
          onOpenChange={setOpen}
          target={{ type: reference.type, id: reference.id }}
          context={reference.type}
          subject={reference.label}
          fallbackEmail={email}
          pageUrl={address}
        />
      ) : null}
    </form>
  );
}
