"use client";

import { useEffect } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useForm } from "react-hook-form";
import type { z } from "@/lib/zod";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useWizard } from "@/lib/listings/client/store";
import { TITLE_MAX, TITLE_MIN, titleStepSchema } from "@/lib/listings/client/validation";
import { useFieldErrorMessage, useValidationMessage } from "../field-messages";
import { STEP_FORM_ID } from "../wizard-shell";
import { CharacterCounter } from "./character-counter";

type Form = z.input<typeof titleStepSchema>;

export function TitleStep({ onNext }: { onNext: () => void }) {
  const { listing, update, flush, blockers } = useWizard();
  const t = useTranslations("Listing.fields");
  const fieldMessage = useFieldErrorMessage();
  const validationMessage = useValidationMessage();
  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors },
  } = useForm<Form>({ resolver: zodResolver(titleStepSchema), defaultValues: { title: listing.title }, mode: "onBlur" });
  const title = watch("title");

  useEffect(() => {
    if (title !== listing.title) update({ title });
  }, [title, listing.title, update]);

  useEffect(() => {
    const blocker = blockers.find((issue) => issue.path === "title");
    if (blocker) setError("title", { type: "server", message: validationMessage(blocker.code) }, { shouldFocus: true });
  }, [blockers, setError, validationMessage]);

  const onSubmit = handleSubmit(() => {
    void flush();
    onNext();
  });

  const error = fieldMessage(errors.title?.type === "too_big" ? "title_max" : "title_min", errors.title);

  return (
    <form id={STEP_FORM_ID} onSubmit={onSubmit} onBlur={() => void flush()} noValidate className="flex flex-col gap-5">
      <Field label={t("title")} hint={t("titleHint")} error={error} required>
        <Input type="text" autoComplete="off" autoFocus={!listing.title} maxLength={TITLE_MAX + 20} placeholder={t("titlePlaceholder")} className="h-13 text-lg" {...register("title")} />
      </Field>
      <CharacterCounter count={title.trim().length} min={TITLE_MIN} max={TITLE_MAX} />
    </form>
  );
}
