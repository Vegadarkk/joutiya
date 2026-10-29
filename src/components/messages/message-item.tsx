"use client";

import { Fragment } from "react";
import { Check, CheckCheck, Clock3, EyeOff, Link2Off, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { AppointmentEventItem } from "@/components/appointments/appointment-event";
import { RentalRequestEventItem } from "@/components/rental/rental-request-event";
import { OfferEventItem } from "@/components/offers/offer-event";
import { Link } from "@/i18n/navigation";
import { HIDDEN_MARKER, URL_MARKER, type MessageRiskFlag, type MessageView } from "@/lib/contracts/messaging";
import { memberTextOf } from "@/lib/messaging/member-text";
import { ReportButton } from "./report-button";
import { cn } from "@/lib/utils";

// One message of a thread (design phase-5 D5, D10): plain text in its own direction, each masked
// link as a "lien masqué" chip, a message hidden by moderation as a muted placeholder, the safety
// warning under a flagged message for its recipient only (the sender sees the masked chips), and
// the report button beside a message received (shown on hover or focus where a pointer hovers).

/** Flags in the order their warnings read, the most specific first. */
const FLAG_ORDER: readonly MessageRiskFlag[] = ["contact_with_payment_kw", "payment_kw", "iban", "external_url"];

/** The warnings shown under an incoming flagged message (none under mine, none when hidden). */
export function warningsFor(message: Pick<MessageView, "mine" | "hidden" | "flags">): MessageRiskFlag[] {
  if (message.mine || message.hidden) return [];
  const flags = FLAG_ORDER.filter((flag) => message.flags.includes(flag));
  // The combined warning already says what the payment one would.
  return flags.includes("contact_with_payment_kw") ? flags.filter((flag) => flag !== "payment_kw") : flags;
}

/** The text split around the masked-link markers. */
export function textParts(text: string): { kind: "text" | "link"; value: string }[] {
  const parts: { kind: "text" | "link"; value: string }[] = [];
  text.split(URL_MARKER).forEach((value, index) => {
    if (index > 0) parts.push({ kind: "link", value: URL_MARKER });
    if (value) parts.push({ kind: "text", value });
  });
  return parts;
}

export function MessageText({ text }: { text: string }) {
  const t = useTranslations("Messaging.thread");
  return (
    <>
      {textParts(text).map((part, index) =>
        part.kind === "text" ? (
          <Fragment key={index}>{part.value}</Fragment>
        ) : (
          <span
            key={index}
            title={t("maskedLinkTitle")}
            className="mx-0.5 inline-flex translate-y-px items-center gap-1 rounded-sm bg-bab-950/10 px-1.5 align-baseline text-[0.8125rem] leading-5 font-medium dark:bg-cream-100/15"
          >
            <Link2Off className="size-3.5 shrink-0" aria-hidden="true" />
            {t("maskedLink")}
          </span>
        ),
      )}
    </>
  );
}

export function RiskWarning({ flags }: { flags: readonly MessageRiskFlag[] }) {
  const t = useTranslations("Messaging.risk");
  if (flags.length === 0) return null;
  return (
    <div role="note" data-testid="risk-warning" className="flex max-w-[85%] gap-2.5 rounded-md border border-warning/30 bg-warning-surface px-3 py-2.5 text-sm sm:max-w-[70%]">
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1 text-foreground">
        <p className="font-medium text-warning">{t("title")}</p>
        {flags.map((flag) => (
          <p key={flag} className="text-pretty">
            {t(flag)}
          </p>
        ))}
        <Link href="/legal/confiance-et-securite" className="self-start font-medium text-link underline underline-offset-4 hover:no-underline">
          {t("more")}
        </Link>
      </div>
    </div>
  );
}

export interface MessageItemProps {
  message: MessageView;
  /** "14:32" */
  time: string;
  /** Under my newest message: sent, read by the other side, or still sending. */
  status?: "sent" | "seen" | "sending";
  /** Shown to screen readers before the text ("Vous", or the other participant's name). */
  sender: string;
  /** Opens the notice form about this message (received messages with their sender's words only). */
  onReport?: (message: MessageView) => void;
}

/**
 * Only a message received, still shown, with its sender's own words can be reported: a text, or a
 * step carrying a place (appointment proposal, booking request; A-02). The server refuses the rest.
 */
export function canReport(message: Pick<MessageView, "mine" | "type" | "hidden" | "text" | "appointment" | "rentalRequest">): boolean {
  return !message.mine && !message.hidden && message.text !== HIDDEN_MARKER && memberTextOf(message) !== null;
}

export function MessageItem({ message, time, status, sender, onReport }: MessageItemProps) {
  const t = useTranslations("Messaging.thread");
  const reportable = onReport !== undefined && canReport(message);
  const report = reportable ? () => onReport(message) : undefined;
  if (message.type === "system" && message.appointment) {
    // `sender` is the other participant's name whenever the step is theirs.
    return <AppointmentEventItem step={message.appointment} counterpartName={sender} time={time} onReport={report} />;
  }
  if (message.type === "system" && message.rentalRequest) {
    return <RentalRequestEventItem step={message.rentalRequest} counterpartName={sender} time={time} onReport={report} />;
  }
  if (message.type === "system" && message.offer) {
    return <OfferEventItem step={message.offer} counterpartName={sender} time={time} />;
  }
  if (message.type === "system") {
    return (
      <li className="flex justify-center py-1">
        <p dir="auto" className="max-w-[90%] rounded-full bg-surface-muted px-3 py-1 text-center text-xs text-foreground-muted text-pretty">
          <span className="sr-only">{t("system")} : </span>
          {message.text}
        </p>
      </li>
    );
  }
  const mine = message.mine;
  const hidden = message.hidden || message.text === HIDDEN_MARKER;
  const warnings = warningsFor(message);
  return (
    <li data-testid="message" data-mine={mine} className={cn("group/message flex flex-col gap-1.5", mine ? "items-end" : "items-start")}>
      <div className={cn("flex w-full items-center gap-1", mine && "justify-end")}>
        <div
          className={cn(
            "max-w-[85%] rounded-2xl px-3.5 pt-2 pb-1.5 sm:max-w-[70%]",
            mine ? "rounded-ee-md bg-structure text-structure-foreground" : "rounded-es-md bg-cream-100 text-foreground dark:bg-surface-muted",
            hidden && "bg-transparent text-foreground-muted ring-1 ring-border ring-inset dark:bg-transparent",
            status === "sending" && "opacity-70",
          )}
        >
          <span className="sr-only">{sender} : </span>
          {hidden ? (
            <p className="flex items-center gap-1.5 text-sm italic">
              <EyeOff className="size-4 shrink-0" aria-hidden="true" />
              {t("hidden")}
            </p>
          ) : (
            <p dir="auto" className="break-words whitespace-pre-wrap [unicode-bidi:plaintext]">
              <MessageText text={message.text} />
            </p>
          )}
          <p className={cn("mt-0.5 flex items-center justify-end gap-1 text-[0.6875rem] leading-4 tabular-nums", mine && !hidden ? "text-structure-foreground/75" : "text-foreground-muted")}>
            <time dateTime={new Date(message.createdAt).toISOString()}>{time}</time>
            {status === "sending" ? (
              <>
                <Clock3 className="size-3" aria-hidden="true" />
                <span className="sr-only">{t("sending")}</span>
              </>
            ) : status === "seen" ? (
              <>
                <CheckCheck className="size-3.5 text-gold-300" aria-hidden="true" />
                <span data-testid="seen">{t("seen")}</span>
              </>
            ) : status === "sent" ? (
              <Check className="size-3.5" aria-hidden="true" />
            ) : null}
          </p>
        </div>
        {report ? <ReportButton onClick={report} /> : null}
      </div>
      {warnings.length > 0 ? <RiskWarning flags={warnings} /> : null}
    </li>
  );
}
