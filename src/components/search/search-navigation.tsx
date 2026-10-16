"use client";

import { createContext, useCallback, useContext, useMemo, useTransition, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { Link, useRouter } from "@/i18n/navigation";
import type { SearchParams } from "@/lib/search/params";
import { cn } from "@/lib/utils";
import { searchLinkHref } from "./filter-model";

// Client navigation of the search page: every filter change is a URL change (the server renders
// the results), run in a transition so the current results stay on screen, dimmed, until the new
// ones arrive. Links keep real hrefs (new tab, no-JS) and only plain clicks go through here.

interface SearchNavigation {
  pending: boolean;
  navigate: (params: SearchParams, options?: { scroll?: boolean }) => void;
  refresh: () => void;
}

const SearchNavigationContext = createContext<SearchNavigation | null>(null);

export function SearchNavigationProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const navigate = useCallback(
    (params: SearchParams, options?: { scroll?: boolean }) => startTransition(() => router.push(searchLinkHref(params), { scroll: options?.scroll ?? true })),
    [router],
  );
  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);
  const value = useMemo(() => ({ pending, navigate, refresh }), [pending, navigate, refresh]);
  return <SearchNavigationContext.Provider value={value}>{children}</SearchNavigationContext.Provider>;
}

/** Null outside the search page (the /c pages reuse the grids without it). */
export function useSearchNavigation(): SearchNavigation | null {
  return useContext(SearchNavigationContext);
}

/** Results area: dimmed and busy while the next results load. */
export function PendingRegion({ children, className }: { children: ReactNode; className?: string }) {
  const pending = useSearchNavigation()?.pending ?? false;
  return (
    <div aria-busy={pending || undefined} data-pending={pending || undefined} className={cn("transition-opacity duration-200 ease-door data-[pending]:pointer-events-none data-[pending]:opacity-55", className)}>
      {children}
    </div>
  );
}

/** Thin progress line under the toolbar while a navigation runs. */
export function PendingBar({ className }: { className?: string }) {
  const pending = useSearchNavigation()?.pending ?? false;
  return (
    <div aria-hidden="true" className={cn("h-0.5 overflow-hidden", className)}>
      {pending ? <div className="h-full w-full animate-pulse bg-primary/80" /> : null}
    </div>
  );
}

type SearchLinkProps = Omit<ComponentProps<typeof Link>, "href" | "prefetch"> & { params: SearchParams; scroll?: boolean };

function plainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** A link to another search: real href, transition navigation on a plain click. */
export function SearchLink({ params, scroll, onClick, ...props }: SearchLinkProps) {
  const navigation = useSearchNavigation();
  return (
    <Link
      {...props}
      href={searchLinkHref(params)}
      prefetch={false}
      scroll={scroll}
      onClick={(event) => {
        onClick?.(event);
        if (!navigation || !plainClick(event)) return;
        event.preventDefault();
        navigation.navigate(params, { scroll: scroll ?? true });
      }}
    />
  );
}
