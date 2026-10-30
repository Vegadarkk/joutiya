// « Masquer les annonces exemples » (owner, 2026-10-30): a device preference kept in a cookie, so
// the search page and /api/search leave the example listings out on the server (counts and pages
// stay right), while the ISR pages, shared by every visitor, hide them in the browser. A constant
// string, like THEME_SCRIPT: its hash is stable across builds, so public pages allow it by hash
// (src/lib/security/inline-hashes.ts) and private pages by nonce. No imports: the CSP hash hook
// bundles this file for plain Node.
//
// It runs before the body paints and sets html[data-examples="hidden"] (styles in globals.css), so
// an example card never flashes on a page that hides them.

/** Cookie holding the choice: "hidden", or absent (the examples show, the default). */
export const EXAMPLES_COOKIE = "examples";
export const EXAMPLES_HIDDEN = "hidden";
/** html attribute mirroring the cookie. */
export const EXAMPLES_ATTRIBUTE = "data-examples";
/** 400 days, the longest a browser keeps a cookie. */
export const EXAMPLES_COOKIE_SECONDS = 400 * 24 * 60 * 60;

export const EXAMPLES_SCRIPT =
  '(function(){try{if(/(^|;\\s*)examples=hidden(;|$)/.test(document.cookie))document.documentElement.setAttribute("data-examples","hidden")}catch(_){}})()';

/** The choice carried by a Cookie request header. */
export function examplesHiddenIn(cookieHeader: string | null | undefined): boolean {
  return /(?:^|;\s*)examples=hidden(?:;|$)/.test(cookieHeader ?? "");
}
