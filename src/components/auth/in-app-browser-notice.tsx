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
  [/LinkedInApp/i, "LinkedIn"],
  [/Twitter/i, "X (Twitter)"],
  [/\bLine\//i, "LINE"],
  // Google app (GSA): its own in-app browser on iOS.
  [/\bGSA\//, "Google"],
];

/** Android's generic WebView marker ("Linux; Android 14; K; wv)"): an embedded browser of an app we cannot name. */
const ANDROID_WEBVIEW = /; wv\)/;

export interface InAppBrowser {
  /** The app owning the webview, or null when only the generic WebView marker is present. */
  app: string | null;
}

/** The in-app browser this page runs in, or null in a regular browser. */
export function detectInAppBrowser(userAgent: string): InAppBrowser | null {
  for (const [pattern, app] of IN_APP_BROWSERS) if (pattern.test(userAgent)) return { app };
  if (ANDROID_WEBVIEW.test(userAgent)) return { app: null };
  return null;
}

export function InAppBrowserNotice({ app }: InAppBrowser) {
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
      {app ? t("body", { app }) : t("bodyGeneric")}
    </ErrorBanner>
  );
}
