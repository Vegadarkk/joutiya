import { ArrowUpRight, Share2 } from "lucide-react";
import { useTranslations } from "next-intl";
import type { SocialNetwork } from "@/config/social-links";
import type { PublicSocialLink } from "@/lib/pro/social-links-rules";
import { cn } from "@/lib/utils";
import { SocialIcon } from "./social-icon";

// The shop's social links on its storefront (src/config/social-links.ts): plain links to each
// network's own profile page, rebuilt from the stored handle. No embed, no widget, no tracking:
// rel="nofollow ugc noopener noreferrer", no referrer sent, a new tab. Never on a listing page.

export const SOCIAL_NETWORK_NAMES: Record<SocialNetwork, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  facebook: "Facebook",
  youtube: "YouTube",
  x: "X",
  linkedin: "LinkedIn",
  snapchat: "Snapchat",
  whatsapp: "WhatsApp Business",
};

/** The handle as the network shows it, or null when it means nothing to a reader (a page id, a WhatsApp code). */
export function socialHandleLabel(network: SocialNetwork, handle: string): string | null {
  if (network === "whatsapp" || (network === "facebook" && /^\d+$/.test(handle))) return null;
  if (network === "linkedin") return handle.slice(handle.indexOf("/") + 1);
  return network === "facebook" ? handle : `@${handle}`;
}

export function SocialLinks({ links, className }: { links: PublicSocialLink[]; className?: string }) {
  const t = useTranslations("Storefront.social");
  if (links.length === 0) return null;
  return (
    <section aria-labelledby="storefront-social" data-testid="storefront-social" className={cn("flex flex-col gap-3 rounded-lg border border-border bg-surface p-5", className)}>
      <h2 id="storefront-social" className="flex items-center gap-2 text-base font-semibold">
        <Share2 className="size-5 shrink-0 text-gold-500 dark:text-gold-300" aria-hidden="true" />
        {t("title")}
      </h2>
      <ul className="flex flex-col gap-1">
        {links.map((link) => {
          const handle = socialHandleLabel(link.network, link.handle);
          return (
            <li key={link.network}>
              <a
                href={link.href}
                target="_blank"
                rel="nofollow ugc noopener noreferrer"
                referrerPolicy="no-referrer"
                className="group -mx-2 flex min-h-11 items-center gap-3 rounded-md px-2 py-1.5 transition-colors duration-150 hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-structure/10 text-structure dark:bg-gold-300/15 dark:text-gold-300">
                  <SocialIcon network={link.network} className="size-[18px]" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium">{SOCIAL_NETWORK_NAMES[link.network]}</span>
                  {handle ? (
                    <span dir="ltr" className="truncate text-start text-xs text-foreground-muted">
                      {handle}
                    </span>
                  ) : null}
                </span>
                <ArrowUpRight className="ms-auto size-4 shrink-0 text-foreground-muted transition-transform duration-150 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover:-translate-x-0.5" aria-hidden="true" />
                <span className="sr-only">{t("newTab")}</span>
              </a>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-foreground-muted text-pretty">{t("note")}</p>
    </section>
  );
}
