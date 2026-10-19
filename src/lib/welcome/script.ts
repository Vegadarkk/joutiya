// Pre-paint decision of the welcome threshold (design C7). A constant string, like THEME_SCRIPT:
// its hash is stable across builds, so public pages allow it by hash
// (src/lib/security/inline-hashes.ts) and private pages by nonce, where it does nothing (only the
// home paths qualify). No imports: the CSP hash hook bundles this file for plain Node.
//
// It runs before the body paints and sets html[data-welcome] (styles in globals.css):
// - "screen": first visit of the home page on this device (the welcome screen);
// - "door": a sign-in that queued the door opening has just landed on the home page.
// Never for deep links (other paths), crawlers or visitors coming from another site (Google's
// intrusive-interstitial rule). The device flags are set as the screen is shown, not on an action.
// The screen also skips a signed-in browser (its session's CSRF cookie, readable by scripts: the
// storage may be gone while the session stays) and browsers without :has(), where "Découvrir sans
// compte" could not get through before hydration (globals.css). A door that the client has not
// started 6 s after paint (scripts failed or still loading) gives way: the page shows without it.

/** html attribute holding the state; removed once the visitor has gone through. */
export const WELCOME_ATTRIBUTE = "data-welcome";
export type WelcomeState = "screen" | "door";

/** localStorage: "seen" once the screen has been shown (or the device signed in). */
export const WELCOME_STORAGE_KEY = "welcome";
export const WELCOME_SEEN = "seen";
/** localStorage: "queued" by a sign-in landing on home, "opened" once the door has played. */
export const DOOR_STORAGE_KEY = "door";
export const DOOR_QUEUED = "queued";
export const DOOR_OPENED = "opened";

/** The home page of each locale (fr, ar, rif), with or without a trailing slash. */
export const HOME_PATH = /^\/(fr|ar|rif)\/?$/;
/** User agents that never get the screen. */
export const CRAWLER_AGENT = /bot|crawler|spider|slurp|facebookexternalhit|bingpreview|embedly|whatsapp|telegrambot/i;
/** A signed-in browser: the session's CSRF cookie (CSRF_COOKIE in src/lib/security/cookies.ts). */
export const SIGNED_IN_COOKIE = /(^|; )__Host-csrf=/;
/** A door still closed this long after paint gives way to the page. */
export const DOOR_FALLBACK_MS = 6000;

export const WELCOME_SCRIPT =
  '(function(){try{var d=document,e=d.documentElement,r=d.referrer,s=localStorage,q;if(!/^\\/(fr|ar|rif)\\/?$/.test(location.pathname)||/bot|crawler|spider|slurp|facebookexternalhit|bingpreview|embedly|whatsapp|telegrambot/i.test(navigator.userAgent)||r&&new URL(r).origin!==location.origin)return;q=s.getItem("door")==="queued";if(!q&&(s.getItem("welcome")||/(^|; )__Host-csrf=/.test(d.cookie)||!CSS.supports("selector(:has(*))")))return;s.setItem("welcome","seen");if(q){s.setItem("door","opened");setTimeout(function(){if(e.getAttribute("data-welcome")==="door")e.removeAttribute("data-welcome")},6000)}e.setAttribute("data-welcome",q?"door":"screen")}catch(_){}})()';
