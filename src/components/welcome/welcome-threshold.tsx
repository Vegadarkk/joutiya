import type { CSSProperties } from "react";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { DoorScene } from "./door-scene";
import { WelcomeDialog } from "./welcome-dialog";

// Welcome threshold of the home page (design C7): the logo's door set in a gate (its inscription
// band above, its tiled frame around) on a night ground, the brand promise, then the three ways in. Rendered in the home page's HTML for every visitor and hidden by
// default; the pre-paint script shows it on a first visit (src/lib/welcome/script.ts). Texts are
// rendered here, so the browser gets no message namespace for it.

const TAGLINE_ID = "welcome-tagline";

const action =
  "inline-flex h-12 items-center justify-center rounded-md px-6 text-base font-medium whitespace-nowrap transition-[background-color,border-color,color,text-decoration-color,scale] duration-150 ease-door active:scale-[0.98]";

export interface WelcomeTexts {
  title: string;
  tagline: string;
  createAccount: string;
  signIn: string;
  discover: string;
}

/** The threshold's texts, loaded with the page's other data (the component itself stays synchronous). */
export async function welcomeTexts(locale: Locale): Promise<WelcomeTexts> {
  const [t, common] = await Promise.all([getTranslations({ locale, namespace: "Welcome" }), getTranslations({ locale, namespace: "Auth.common" })]);
  return { title: t("title"), tagline: common("brandPromise"), createAccount: t("createAccount"), signIn: t("signIn"), discover: t("discover") };
}

export function WelcomeThreshold({ locale, texts }: { locale: Locale; texts: WelcomeTexts }) {
  // Sign-up and sign-in come back here, where the door then opens (src/lib/welcome/flags.ts).
  const next = `/${locale}`;
  return (
    <WelcomeDialog labelledBy={TAGLINE_ID}>
      {/* Tarifit has no Welcome texts yet: they fall back to French. */}
      <div lang={locale === "rif" ? "fr" : undefined} className="m-auto flex w-full max-w-3xl flex-col items-center px-4 py-8 sm:py-10">
        {/* The gate's inscription band. Steps of the entrance: .welcome-enter, globals.css. */}
        {/* Its length sizes the band on a phone: whatever the brand's name, it holds on one line (globals.css). */}
        <h2 className="welcome-crest welcome-enter" data-welcome-part="crest" style={{ "--welcome-crest-chars": texts.title.length } as CSSProperties}>
          <CrestRule />
          <span className="welcome-crest-text">{texts.title}</span>
          <CrestRule />
        </h2>
        <div className="welcome-gate welcome-enter" data-enter="door">
          <DoorScene />
        </div>
        <div className="welcome-copy mt-7 flex w-full flex-col items-center gap-6 text-center sm:mt-9 sm:gap-8" data-welcome-part="copy">
          <p id={TAGLINE_ID} className="welcome-tagline welcome-enter max-w-[18ch] text-balance sm:max-w-none" data-enter="copy">
            {texts.tagline}
          </p>
          <div className="welcome-enter flex w-full max-w-sm flex-col gap-3 sm:w-auto sm:max-w-none sm:flex-row sm:items-center sm:justify-center" data-enter="actions">
            <Link href={{ pathname: "/inscription", query: { next } }} prefetch={false} className={cn(action, "bg-gold-400 text-bab-950 hover:bg-gold-300")}>
              {texts.createAccount}
            </Link>
            <Link
              href={{ pathname: "/connexion", query: { next } }}
              prefetch={false}
              className={cn(action, "border border-cream-200/60 text-cream-200 hover:border-cream-200 hover:bg-cream-200/10")}
            >
              {texts.signIn}
            </Link>
            {/* A link to the page itself: it lets the visitor through even before hydration (globals.css). */}
            <a
              href="#main"
              data-welcome-action="discover"
              className={cn(action, "px-4 text-cream-200 underline decoration-transparent underline-offset-[0.3em] hover:decoration-cream-200/70")}
            >
              {texts.discover}
            </a>
          </div>
        </div>
      </div>
    </WelcomeDialog>
  );
}

/** A gold rule ending in the logo's eight-pointed star, on each side of the inscription (mirrored by CSS). */
function CrestRule() {
  return (
    <svg className="welcome-crest-rule" viewBox="0 0 72 16" aria-hidden="true" focusable="false">
      <path d="M0 8H54" />
      <path d="M64 1.5L65.9 3.4H68.6V6.1L70.5 8L68.6 9.9V12.6H65.9L64 14.5L62.1 12.6H59.4V9.9L57.5 8L59.4 6.1V3.4H62.1Z" />
    </svg>
  );
}
