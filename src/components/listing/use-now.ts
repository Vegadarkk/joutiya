"use client";

import { useEffect, useState } from "react";

/**
 * The current time in epoch ms, ticking every `intervalMs` while `enabled`. Starts at the server's
 * render time so the first client render matches the HTML (an ISR page can be minutes old), then
 * follows the browser clock from the first tick, right after hydration.
 */
export function useNow(renderedAt: number, intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(renderedAt);
  useEffect(() => {
    if (!enabled) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [enabled, intervalMs]);
  return now;
}
