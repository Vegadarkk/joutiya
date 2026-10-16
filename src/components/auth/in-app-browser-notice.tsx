"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";

// Google refuses OAuth inside the webviews of social apps (disallowed_useragent, §6): tell the
// person to open the page in a real browser, and keep the e-mail form as the way in.

const IN_APP_BROWSERS: [RegExp, string][] = [
  [/FBAN|FBAV|FB_IAB|FBIOS|FB4A/i, "Facebook"],
  [/Instagram/i, "Instagram"],
  [/WhatsApp/i, "WhatsApp"],
  [/TikTok|musical_ly|BytedanceWebview|Bytedance/i, "TikTok"],
  [/Snapchat/i, "Snapchat"],
];

/** The social app owning this webview, or null in a regular browser. */
export function inAppBrowserName(userAgent: string): string | null {
  for (const [pattern, name] of IN_APP_BROWSERS) if (pattern.test(userAgent)) return name;
  return null;
}

export function InAppBrowserNotice({ app }: { app: string }) {
  const t = useTranslations("Auth.common.inApp");
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard blocked: the address bar still shows the link.
    }
  }
  return (
    <ErrorBanner
      tone="info"
      title={t("title")}
      action={
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? t("copied") : t("copy")}
        </Button>
      }
    >
      {t("body", { app })}
    </ErrorBanner>
  );
}
