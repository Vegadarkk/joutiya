"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Dialog } from "radix-ui";
import type { AppointmentKind, AppointmentResponse } from "@/lib/contracts/appointments";
import { postAppointmentAction } from "@/lib/appointments/client";
import { isolate } from "@/lib/i18n/bidi";
import { cn } from "@/lib/utils";
import { useAppointmentErrorMessage } from "./errors";
import { SlotPicker, type SlotPickerValue } from "./slot-picker";

// The slot picker in a sheet (mobile) or a dialog: posts the proposal of `cid`. A proposal while
// an appointment is active reschedules it (the server says so in the thread).

export interface AppointmentDialogProps {
  cid: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The other participant. */
  counterpartName: string;
  defaultKind?: AppointmentKind;
  kinds?: readonly AppointmentKind[];
  /** An active appointment exists: the dialog reads "propose other slots". */
  rescheduling?: boolean;
  onDone: (response: AppointmentResponse) => void;
}

export function AppointmentDialog({ cid, open, onOpenChange, counterpartName, defaultKind, kinds, rescheduling, onDone }: AppointmentDialogProps) {
  const t = useTranslations("Appointments.dialog");
  const errorMessage = useAppointmentErrorMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(value: SlotPickerValue) {
    setBusy(true);
    setError(null);
    try {
      const response = await postAppointmentAction(cid, { action: "propose", ...value });
      onDone(response);
      onOpenChange(false);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          data-testid="appointment-dialog"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col overflow-y-auto rounded-t-lg border border-border bg-surface shadow-xl shadow-bab-950/20 outline-none",
            "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg rtl:sm:translate-x-1/2",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <div className="flex flex-col gap-5 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <Dialog.Title className="text-xl font-semibold text-balance">{rescheduling ? t("rescheduleTitle") : t("title")}</Dialog.Title>
                <Dialog.Description className="text-sm text-foreground-muted text-pretty">{t("lead", { name: isolate(counterpartName) })}</Dialog.Description>
              </div>
              <Dialog.Close className="-me-2 -mt-1 inline-flex size-10 shrink-0 items-center justify-center rounded-full text-foreground-muted hover:bg-surface-muted hover:text-foreground" aria-label={t("close")}>
                <X className="size-5" aria-hidden="true" />
              </Dialog.Close>
            </div>
            <SlotPicker defaultKind={defaultKind} kinds={kinds} submitting={busy} error={error} onSubmit={(value) => void submit(value)} onCancel={() => onOpenChange(false)} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
