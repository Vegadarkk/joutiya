// Pages where parts of the shell step aside (paths without the locale, as usePathname gives them).

const under = (pathname: string, paths: readonly string[]) => paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));

/**
 * Focused flows: posting, signing in, the conversations (their shell fills the viewport under the
 * header, src/components/messages/messages-shell.tsx) and the anti-robot check. No category row.
 */
const FOCUSED_PATHS = ["/deposer", "/connexion", "/inscription", "/mot-de-passe-oublie", "/action", "/messages", "/anti-robot"];

/** Pages with their own bar at the bottom of a phone: the listing's contact bar, the Pro save bars. */
const BOTTOM_BAR_PATHS = ["/annonce", "/pro"];

/** The search page (lot 2): its own filters and category shortcuts sit beside the results. */
const SEARCH_PATHS = ["/recherche"];

export function showsCategoryRow(pathname: string): boolean {
  return !under(pathname, FOCUSED_PATHS) && !under(pathname, SEARCH_PATHS);
}

export function showsSellButton(pathname: string): boolean {
  return !under(pathname, FOCUSED_PATHS) && !under(pathname, BOTTOM_BAR_PATHS);
}
