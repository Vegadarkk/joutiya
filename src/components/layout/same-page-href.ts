"use client";

import { useSearchParams } from "next/navigation";
import { usePathname } from "@/i18n/navigation";

// The same page in another language, query string included: search filters, ?next= of the
// challenge page and the unsubscribe token live in the URL. Only the language menu and its link
// fallback call this, and they render after the visitor's click: useSearchParams never runs while
// a static page prerenders, so the header needs no Suspense boundary for it.
export function useSamePageHref(): string {
  const pathname = usePathname();
  const query = useSearchParams().toString();
  return query ? `${pathname}?${query}` : pathname;
}
