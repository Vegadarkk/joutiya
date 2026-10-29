"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FormMessage } from "@/components/auth/form-message";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SOCIAL_INPUT_MAX, SOCIAL_NETWORKS, socialHref, type SocialNetwork } from "@/config/social-links";
import { isApiError } from "@/lib/auth/client";
import type { ProSelfView, ProSocialView, SocialLinkIssueDetails } from "@/lib/contracts/pro";
import { saveSocialLinks } from "@/lib/pro/client";
import { checkSocialLink, type SocialLinkIssue } from "@/lib/pro/social-links-rules";
import { SocialIcon } from "./social-icon";
import { SOCIAL_NETWORK_NAMES } from "./social-links";

// The shop's social links in the Pro area (src/config/social-links.ts): one field per network, a
// handle or the profile address. The server's check runs as the shop types and shows the link the
// storefront will open; the server runs it again before storing the handle.

type Draft = Record<SocialNetwork, string>;

function draftOf(social: ProSocialView): Draft {
  const draft = Object.fromEntries(SOCIAL_NETWORKS.map((network) => [network, ""])) as Draft;
  for (const link of social.links) draft[link.network] = link.network === "whatsapp" ? link.href : link.handle.includes("/") ? link.href : `@${link.handle}`;
  return draft;
}

export function SocialLinksSettings({ shop }: { shop: Pick<ProSelfView, "social"> }) {
  const t = useTranslations("Pro.social");
  const [social, setSocial] = useState<ProSocialView>(shop.social);
  const [saved, setSaved] = useState<Draft>(() => draftOf(shop.social));
  const [draft, setDraft] = useState<Draft>(() => draftOf(shop.social));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const dirty = SOCIAL_NETWORKS.some((network) => draft[network].trim() !== saved[network].trim());
  const checks = Object.fromEntries(SOCIAL_NETWORKS.map((network) => [network, draft[network].trim() ? checkSocialLink(network, draft[network]) : null])) as Record<SocialNetwork, ReturnType<typeof checkSocialLink> | null>;
  const serverIssue = isApiError(failure, "social_link_invalid") ? (failure.details as SocialLinkIssueDetails | undefined) : undefined;
  const issueOf = (network: SocialNetwork): SocialLinkIssue | null => {
    const check = checks[network];
    if (check && "problem" in check) return check.problem;
    return serverIssue?.network === network ? serverIssue.problem : null;
  };
  const blocked = SOCIAL_NETWORKS.some((network) => {
    const check = checks[network];
    return check !== null && "problem" in check;
  });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !dirty || blocked) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await saveSocialLinks({ links: SOCIAL_NETWORKS.filter((network) => draft[network].trim()).map((network) => ({ network, value: draft[network].trim() })) });
      setSocial(result.social);
      const next = draftOf(result.social);
      setSaved(next);
      setDraft(next);
      toast.success(t("saved"));
    } catch (caught) {
      setFailure(caught);
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="pro-social" data-testid="social-settings" className="flex flex-col gap-5 rounded-lg border border-border bg-surface p-5">
      <header className="flex flex-col gap-1">
        <h2 id="pro-social" className="text-lg font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-foreground-muted text-pretty">{t("lead")}</p>
      </header>
      {social.hidden ? (
        <ErrorBanner tone="warning" title={t("hiddenTitle")}>
          {t("hiddenBody", { reason: social.hidden.reason })}
        </ErrorBanner>
      ) : null}
      <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-5">
        <div className="grid gap-4 md:grid-cols-2">
          {SOCIAL_NETWORKS.map((network) => {
            const check = checks[network];
            const issue = issueOf(network);
            const href = check && "handle" in check ? socialHref(network, check.handle) : null;
            return (
              <Field
                key={network}
                label={
                  <span className="inline-flex items-center gap-2">
                    <SocialIcon network={network} className="text-structure dark:text-gold-300" />
                    {SOCIAL_NETWORK_NAMES[network]}
                  </span>
                }
                error={issue ? t(`problems.${issue}`) : undefined}
                hint={
                  href ? (
                    <span className="break-all" dir="ltr">
                      {href.replace(/^https:\/\//, "")}
                    </span>
                  ) : (
                    t(`hints.${network}`)
                  )
                }
              >
                <Input
                  value={draft[network]}
                  inputMode="url"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  dir="ltr"
                  maxLength={SOCIAL_INPUT_MAX}
                  placeholder={t(`placeholders.${network}`)}
                  data-network={network}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, [network]: event.target.value }));
                    if (serverIssue?.network === network) setFailure(null);
                  }}
                />
              </Field>
            );
          })}
        </div>
        <p className="text-xs text-foreground-muted text-pretty">{t("rules")}</p>
        {failure && !serverIssue ? <FormMessage error={failure} title={t("failed")} /> : null}
        <Button type="submit" className="w-fit" loading={pending} disabled={!dirty || blocked}>
          {t("save")}
        </Button>
      </form>
    </section>
  );
}
