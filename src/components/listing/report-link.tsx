import { Flag } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

// "Signaler" (listing or profile) until the notice-and-action form of phase 5 (DSA art. 16): an
// e-mail to the DSA point of contact (config/legal), with the content's URL and id already written,
// so a notice is never more than one tap away.

export interface ReportLinkProps {
  /** dsaContactEmail of the legal config. */
  email: string;
  target: "listing" | "profile";
  /** Listing id or publicId. */
  id: string;
  /** Absolute canonical URL of the page. */
  url: string;
  className?: string;
}

/** `mailto:` with a subject and a body; spaces as %20 (mail clients show "+" literally). */
export function reportMailto(email: string, subject: string, body: string): string {
  const params = new URLSearchParams({ subject, body });
  return `mailto:${email}?${params.toString().replace(/\+/g, "%20")}`;
}

export function ReportLink({ email, target, id, url, className }: ReportLinkProps) {
  const t = useTranslations("ListingPage.report");
  const href = reportMailto(email, t(`${target}.subject`, { id }), t("body", { url }));
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <a href={href} className="inline-flex min-h-11 items-center gap-2 self-start rounded-sm text-sm font-medium text-foreground-muted underline underline-offset-4 hover:text-foreground hover:no-underline">
        <Flag className="size-4" aria-hidden="true" />
        {t(`${target}.link`)}
      </a>
      <p className="text-xs text-foreground-muted text-pretty">{t("hint")}</p>
    </div>
  );
}
