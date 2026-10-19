"use client";

import type { FormEvent } from "react";
import { BadgeCheck, MessageSquare, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { useSession } from "@/lib/auth/client";
import { usePublicConfig } from "@/lib/config/client";
import { useWizard } from "@/lib/listings/client/store";
import { SwitchField } from "../controls/switch";
import { STEP_FORM_ID } from "../wizard-shell";

/** Step 8: messaging is always on; the phone and WhatsApp switches need the verified badge (phase 2, /verifications). */
export function ContactStep({ onNext }: { onNext: () => void }) {
  const { listing, update, blockers } = useWizard();
  const t = useTranslations("Listing");
  const { status, session } = useSession();
  const known = status === "ready";
  const verified = Boolean(session?.phoneVerified);
  // While the WhatsApp check is closed, explain why the switches stay off instead of linking to a 503.
  const phoneOpen = usePublicConfig()?.phoneVerification !== false;
  // Without the badge the switches can be turned off, never on (the API refuses: phone_required).
  const blocked = known && !verified && (listing.contact.showPhone || listing.contact.whatsapp);
  const blocker = blockers.find((issue) => issue.path.startsWith("contact"));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    onNext();
  }

  return (
    <form id={STEP_FORM_ID} onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <div className="flex gap-3 rounded-lg bg-surface-brand px-4 py-3">
        <MessageSquare className="mt-0.5 size-5 shrink-0 text-structure" aria-hidden="true" />
        <p className="text-sm text-pretty">{t("contact.messagesAlways")}</p>
      </div>

      <section aria-labelledby="contact-phone-title" className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="contact-phone-title" className="font-semibold">
            {t("steps.contact")}
          </h2>
          {!known ? null : verified ? (
            <Badge variant="success">
              <BadgeCheck className="size-3.5" aria-hidden="true" />
              {t("contact.phoneVerified")}
            </Badge>
          ) : phoneOpen ? (
            <Badge variant="warning">{t("contact.phoneNotVerified")}</Badge>
          ) : null}
        </div>
        {known && !verified && !phoneOpen ? (
          <p className="text-sm text-foreground-muted text-pretty">{t("contact.verifySoon")}</p>
        ) : known && !verified ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-foreground-muted text-pretty">{t("contact.verifyBody")}</p>
            <Button asChild variant="outline" size="sm" className="shrink-0 max-sm:h-11">
              <Link href="/verifications">{t("contact.verifyLink")}</Link>
            </Button>
          </div>
        ) : null}
        <div className="flex flex-col divide-y divide-border">
          <SwitchField
            label={t("fields.showPhone")}
            hint={t("fields.showPhoneHint")}
            checked={listing.contact.showPhone}
            disabled={!verified && !listing.contact.showPhone}
            onCheckedChange={(showPhone) => update({ contact: { ...listing.contact, showPhone } }, { flush: true })}
            className="py-3"
          />
          <SwitchField
            label={t("fields.whatsapp")}
            hint={t("fields.whatsappHint")}
            checked={listing.contact.whatsapp}
            disabled={!verified && !listing.contact.whatsapp}
            onCheckedChange={(whatsapp) => update({ contact: { ...listing.contact, whatsapp } }, { flush: true })}
            className="py-3"
          />
        </div>
        {blocker || blocked ? (
          <p role="alert" className="text-sm text-danger">
            {t("validation.phone_required")}
          </p>
        ) : null}
      </section>

      <p className="flex gap-2 text-sm text-foreground-muted">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("contact.revealNote")}
      </p>
    </form>
  );
}
