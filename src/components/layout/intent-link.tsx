"use client";

import { useState, type ComponentProps } from "react";
import { Link } from "@/i18n/navigation";

/**
 * A link that prefetches its route on intent (pointer over it, touch, keyboard focus) instead of as
 * soon as it is in the viewport: the "hover-triggered prefetch" of the Next.js prefetching guide.
 * For links present on every page whose target is costly to prefetch for nothing, such as the home
 * page behind the header logo (its whole RSC payload, fetched while the page is still loading).
 */
export function IntentLink({ onMouseEnter, onTouchStart, onFocus, ...props }: Omit<ComponentProps<typeof Link>, "prefetch">) {
  const [active, setActive] = useState(false);
  return (
    <Link
      {...props}
      prefetch={active ? null : false}
      onMouseEnter={(event) => {
        setActive(true);
        onMouseEnter?.(event);
      }}
      onTouchStart={(event) => {
        setActive(true);
        onTouchStart?.(event);
      }}
      onFocus={(event) => {
        setActive(true);
        onFocus?.(event);
      }}
    />
  );
}
