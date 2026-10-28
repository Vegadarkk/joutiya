import { useTranslations } from "next-intl";
import { ExternalLink, Landmark } from "lucide-react";
import { SITE_NAME } from "@/config/site";
import { GUIDE_SOURCES, sourceAuthority, sourceDomain, type GuideSourceId } from "@/content/guide";
import { textLinkClassName } from "@/components/ui/text-link";
import { cn } from "@/lib/utils";

// One official link of the admin procedures guide (design guide-demarches G2): the label in the
// visitor's language, then the authority and its domain, the trust signal a visitor checks in the
// address bar. "withdrawn" keeps the label without the address while the checker sees the page
// broken or redirected off the official hosts. Opens in a new tab, without referrer.

export function OfficialLink({ id, label, display }: { id: GuideSourceId; label: string; display: "live" | "withdrawn" }) {
  const t = useTranslations("Guide");
  const source = GUIDE_SOURCES[id];
  const langs = source.langs.map((lang) => t(`lang.${lang}`)).join(", ");
  return (
    <li className="flex gap-3 py-3">
      <Landmark aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-structure dark:text-gold-300" />
      <div className="flex min-w-0 flex-col gap-0.5">
        {display === "live" ? (
          <a href={source.url} target="_blank" rel="noopener noreferrer external" referrerPolicy="no-referrer" className={cn("inline-flex items-baseline gap-1.5 font-medium text-link", textLinkClassName)}>
            <span>{label}</span>
            <ExternalLink aria-hidden="true" className="size-3.5 shrink-0 self-center rtl:-scale-x-100" />
            <span className="sr-only">{t("newTab")}</span>
          </a>
        ) : (
          <span className="font-medium">{label}</span>
        )}
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-foreground-muted">
          <span>{sourceAuthority(id)}</span>
          <bdi dir="ltr" className="font-medium text-foreground">
            {sourceDomain(id)}
          </bdi>
          <span className="sr-only">. </span>
          <span className="basis-full text-xs">{t("langs", { langs })}</span>
        </p>
        {display === "withdrawn" ? <p className="text-sm text-warning">{t("withdrawn")}</p> : null}
      </div>
    </li>
  );
}

/** The guide's disclaimer (G3): information only, the official source prevails. */
export function GuideDisclaimer({ className }: { className?: string }) {
  const t = useTranslations("Guide");
  return (
    <aside aria-labelledby="guide-disclaimer" className={cn("flex flex-col gap-1.5 rounded-lg border border-warning/30 bg-warning-surface px-5 py-4", className)}>
      <h2 id="guide-disclaimer" className="font-semibold text-warning">
        {t("disclaimerTitle")}
      </h2>
      <p className="text-sm text-pretty">{t("disclaimer", { brand: SITE_NAME })}</p>
    </aside>
  );
}
