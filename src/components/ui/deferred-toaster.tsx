"use client";

import { Suspense, useEffect, useState } from "react";
import { lazyIsland } from "@/components/layout/lazy-island";
import { whenIdle } from "@/lib/browser/when-idle";

// The toast container (sonner) mounts once the page is idle, from its own chunk: public pages show
// no toast before an action, and sonner replays the toasts still active when its container
// subscribes (Observer.subscribe in 2.0.8, the pinned version), so an early toast shows late,
// never not at all. A chunk that cannot be loaded leaves the page without toasts, not without page.

const Toaster = lazyIsland<{ dir: "ltr" | "rtl" }>(() => import("./toaster").then((module) => ({ default: module.Toaster })), NoToaster);

function NoToaster(): null {
  return null;
}

export function DeferredToaster({ dir }: { dir: "ltr" | "rtl" }) {
  const [ready, setReady] = useState(false);
  useEffect(() => whenIdle(() => setReady(true)), []);
  return ready ? (
    <Suspense fallback={null}>
      <Toaster dir={dir} />
    </Suspense>
  ) : null;
}
