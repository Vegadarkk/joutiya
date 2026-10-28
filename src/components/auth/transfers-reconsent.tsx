"use client";

import { useId, useState, useTransition, type ReactNode } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { LogOut } from "lucide-react";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import type { z } from "@/lib/zod";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { apiPost, signOut } from "@/lib/auth/client";
import { AUTH_API, transfersConsentSchema, type ConsentsResponse } from "@/lib/contracts/auth";
import { ConsentBox, TransfersDetails } from "./consent-fields";
import { FormMessage, useFieldMessage } from "./form-message";

// Blocking re-consent panel (design D12), rendered by (account)/layout.tsx in place of the page
// while the member's transfers consent is not the current version (transfersConsentVersion). Accepting records it and
// refreshes the route, which then renders the page. Without it the account cannot be used: the
// panel offers the sign-out and the address to ask for the account's deletion.

type ReconsentForm = z.input<typeof transfersConsentSchema>;
type ReconsentInput = z.output<typeof transfersConsentSchema>;

export function TransfersReconsent({ dpo }: { dpo: string }) {
  const t = useTranslations("Auth.reconsent");
  const consents = useTranslations("Auth.consents");
  const router = useRouter();
  const fieldMessage = useFieldMessage();
  const refuseId = useId();
  const [serverError, setServerError] = useState<unknown>();
  const [refreshing, startRefresh] = useTransition();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ReconsentForm, unknown, ReconsentInput>({ resolver: zodResolver(transfersConsentSchema), mode: "onTouched" });

  async function onValid(values: ReconsentInput) {
    setServerError(undefined);
    try {
      await apiPost<ConsentsResponse>(AUTH_API.consents, values);
      toast.success(t("accepted"));
      startRefresh(() => router.refresh());
    } catch (error) {
      setServerError(error);
    }
  }

  async function onSignOut() {
    await signOut();
    toast.success(t("signedOut"));
    router.replace("/");
    router.refresh();
  }

  const mail = (chunks: ReactNode) =>
    dpo.includes("@") ? (
      <a href={`mailto:${dpo}`} dir="ltr" className="font-medium text-link underline underline-offset-2">
        {chunks}
      </a>
    ) : (
      <span dir="ltr">{chunks}</span>
    );

  return (
    <div className="flex flex-col gap-10">
      <form onSubmit={(event) => void handleSubmit(onValid)(event)} noValidate className="flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold text-balance">{t("title")}</h1>
          <p className="text-foreground-muted text-pretty">{t("lead")}</p>
        </header>
        <FormMessage error={serverError} />
        <ConsentBox field={register("transfers")} error={fieldMessage("consent", errors.transfers)} required details={<TransfersDetails open />}>
          {consents("transfers")}
        </ConsentBox>
        <Button type="submit" loading={isSubmitting || refreshing} className="w-full sm:w-fit">
          {t("submit")}
        </Button>
      </form>
      <section aria-labelledby={refuseId} className="flex flex-col gap-3 border-t border-border pt-8">
        <h2 id={refuseId} className="text-lg font-semibold text-balance">
          {t("refuseTitle")}
        </h2>
        <p className="text-sm text-foreground-muted text-pretty">{t.rich("refuseBody", { dpo, mail })}</p>
        <Button type="button" variant="outline" onClick={() => void onSignOut()} className="w-fit">
          <LogOut aria-hidden="true" />
          {t("signOut")}
        </Button>
      </section>
    </div>
  );
}
