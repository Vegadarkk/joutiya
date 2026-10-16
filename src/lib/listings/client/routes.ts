import { LISTING_ID_PATTERN } from "@/lib/listings/ids";
import { WIZARD_DONE, type WizardStep } from "@/lib/contracts/listings";
import { isWizardStep } from "./validation";

// Paths of the wizard (design D3): `/deposer`, `/deposer/{id}`, `/deposer/{id}/{step}`,
// `/deposer/{id}/termine`. Locale prefix excluded (next-intl adds it).

export type WizardScreen = WizardStep | typeof WIZARD_DONE;

export function wizardPath(id: string, screen?: WizardScreen): string {
  return screen ? `/deposer/${id}/${screen}` : `/deposer/${id}`;
}

export interface ParsedWizardPath {
  id: string | null;
  screen: WizardScreen | null;
  /** True when the path is `/deposer/...` but names an unknown id or screen. */
  invalid: boolean;
}

/** Parses a pathname with or without a locale prefix. */
export function parseWizardPath(pathname: string): ParsedWizardPath {
  const segments = pathname.split("/").filter(Boolean);
  const start = segments.indexOf("deposer");
  if (start === -1) return { id: null, screen: null, invalid: true };
  const [id, screen, ...rest] = segments.slice(start + 1);
  if (id === undefined) return { id: null, screen: null, invalid: false };
  if (!LISTING_ID_PATTERN.test(id) || rest.length > 0) return { id: null, screen: null, invalid: true };
  if (screen === undefined) return { id, screen: null, invalid: false };
  if (screen === WIZARD_DONE || isWizardStep(screen)) return { id, screen, invalid: false };
  return { id, screen: null, invalid: true };
}
