"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { MessageCircleQuestion } from "lucide-react";
import { useTranslations } from "next-intl";
import { lazyIsland } from "@/components/layout/lazy-island";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ASSISTANT_HASH, OPEN_ASSISTANT_EVENT } from "./assistant-event";
import type { AssistantPanelProps } from "./assistant-panel";

// The help pages' entry to the Assistant Joutiya (design phase-5 D25): a button, the panel loaded on
// first use (its own chunk: radix dialog, Turnstile, the API client), kept mounted afterwards so
// the conversation survives a close. Opens on /aide#assistant (account menu) and on the event.

const AssistantPanel = lazyIsland<AssistantPanelProps>(() => import("./assistant-panel"), () => null);

export function AssistantLauncher({ className, variant = "structure" }: { className?: string; variant?: "structure" | "outline" }) {
  const t = useTranslations("Help.assistant");
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const show = useCallback(() => {
    setLoaded(true);
    setOpen(true);
  }, []);

  useEffect(() => {
    const fromHash = () => {
      if (window.location.hash === ASSISTANT_HASH) show();
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    window.addEventListener(OPEN_ASSISTANT_EVENT, show);
    return () => {
      window.removeEventListener("hashchange", fromHash);
      window.removeEventListener(OPEN_ASSISTANT_EVENT, show);
    };
  }, [show]);

  function onOpenChange(next: boolean) {
    setOpen(next);
    // A reload must not reopen it.
    if (!next && window.location.hash === ASSISTANT_HASH) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  }

  return (
    <>
      <Button type="button" variant={variant} size="lg" onClick={show} onPointerEnter={() => setLoaded(true)} className={cn("h-auto min-h-13 w-full py-2.5 whitespace-normal sm:w-auto", className)}>
        <MessageCircleQuestion aria-hidden="true" />
        {t("open")}
      </Button>
      {loaded ? (
        <Suspense fallback={null}>
          <AssistantPanel open={open} onOpenChange={onOpenChange} />
        </Suspense>
      ) : null}
    </>
  );
}
