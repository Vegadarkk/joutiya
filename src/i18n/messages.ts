import type { Locale } from "@/config/site";
import type fr from "../../messages/fr.json";

export type Messages = typeof fr;

type Tree = { [key: string]: string | Tree };

function isTree(value: unknown): value is Tree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge: keys of `override` win, missing keys come from `base`. */
export function mergeMessages(base: Tree, override: Tree): Tree {
  const result: Tree = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isTree(value) && isTree(current) ? mergeMessages(current, value) : value;
  }
  return result;
}

/** Messages of a locale over the French base, so a missing key always falls back to French. */
export async function loadMessages(locale: Locale): Promise<Messages> {
  const base = (await import("../../messages/fr.json")).default as Tree;
  if (locale === "fr") return base as Messages;
  const own =
    locale === "ar"
      ? (await import("../../messages/ar.json")).default
      : (await import("../../messages/rif.json")).default;
  return mergeMessages(base, own as Tree) as Messages;
}
