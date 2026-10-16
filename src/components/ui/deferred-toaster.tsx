"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { whenIdle } from "@/lib/browser/when-idle";

// The toast container (sonner) mounts once the page is idle, from its own chunk: public pages show
// no toast before an action, and sonner replays the toasts raised before its container subscribes.

const Toaster = lazy(() => import("./toaster").then((module) => ({ default: module.Toaster })));

export function DeferredToaster({ dir }: { dir: "ltr" | "rtl" }) {
  const [ready, setReady] = useState(false);
  useEffect(() => whenIdle(() => setReady(true)), []);
  return ready ? (
    <Suspense fallback={null}>
      <Toaster dir={dir} />
    </Suspense>
  ) : null;
}
