import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import type { Locale } from "@/config/site";
import { routing } from "./routing";

/** The [locale] param as a Locale; an unknown value is a 404 (layouts already reject it). */
export function pageLocale(value: string): Locale {
  if (!hasLocale(routing.locales, value)) notFound();
  return value;
}
