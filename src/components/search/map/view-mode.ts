// Map or list on the search page (Carte vivante, lot 2): pure rules, read by the client root.
// The map is the default when the runtime config has a basemap and the browser can draw it
// (WebGL2); a visitor who saves data or sits on a 2G link starts on the list (the map costs
// ~430 KB of script plus tiles). A choice made with the toggle is remembered on the device.

export type SearchView = "map" | "list";

export const VIEW_STORAGE_KEY = "search-view";

export interface ViewContext {
  /** publicConfig.map is set (a PMTiles archive is configured). */
  hasMap: boolean;
  webgl2: boolean;
  /** navigator.connection.saveData */
  saveData?: boolean;
  /** navigator.connection.effectiveType ("slow-2g", "2g", "3g", "4g"). */
  effectiveType?: string;
  /** The visitor's last choice on this device, if any. */
  stored?: string | null;
}

/** Whether the map can be shown at all. */
export function mapPossible(context: Pick<ViewContext, "hasMap" | "webgl2">): boolean {
  return context.hasMap && context.webgl2;
}

export function slowConnection(context: Pick<ViewContext, "saveData" | "effectiveType">): boolean {
  return context.saveData === true || context.effectiveType === "2g" || context.effectiveType === "slow-2g";
}

/** The view the page starts in once hydrated. */
export function initialView(context: ViewContext): SearchView {
  if (!mapPossible(context)) return "list";
  if (context.stored === "map" || context.stored === "list") return context.stored;
  return slowConnection(context) ? "list" : "map";
}

/** The browser's side of the context (client only; every read is guarded). */
export function browserViewContext(hasMap: boolean, webgl2: boolean): ViewContext {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
  } catch {
    stored = null;
  }
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return { hasMap, webgl2, saveData: connection?.saveData, effectiveType: connection?.effectiveType, stored };
}

export function rememberView(view: SearchView): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Private window or blocked storage: the choice lasts for this page only.
  }
}
